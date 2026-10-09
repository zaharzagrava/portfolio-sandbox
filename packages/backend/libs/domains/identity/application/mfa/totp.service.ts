import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import User from '../../infra/models/user.model';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { SecretBox } from '../../infra/crypto/secret-box';

const ISSUER = 'Marketplace';
const RECOVERY_CODES = 10;
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/**
 * TOTP second factor (RFC 6238). Secrets are stored encrypted; recovery codes
 * hashed and single-use. Each accepted code's time step is remembered so the
 * same 6 digits can't be replayed within their 30-s validity window.
 */
@Injectable()
export class TotpService {
  constructor(
    @InjectModel(User) private readonly userModel: typeof User,
    private readonly box: SecretBox,
    private readonly redis: RedisService,
  ) {}

  /** Step 1: generate a secret (not active until confirmed with a valid code). */
  async enroll(
    user: Pick<User, 'id' | 'email'>,
  ): Promise<{ otpauthUri: string }> {
    const secret = generateSecret();
    await this.userModel.update(
      { mfaSecretEnc: this.box.seal(secret), mfaEnabledAt: null },
      { where: { id: user.id } },
    );
    return {
      otpauthUri: generateURI({
        issuer: ISSUER,
        label: user.email ?? user.id,
        secret,
      }),
    };
  }

  /** Step 2: prove the authenticator app works → MFA on, recovery codes shown once. */
  async confirm(
    userId: string,
    code: string,
  ): Promise<{ recoveryCodes: string[] } | null> {
    const user = await this.userModel.findByPk(userId);
    if (!user?.mfaSecretEnc || !(await this.verifyCode(user, code)))
      return null;

    const recoveryCodes = Array.from({ length: RECOVERY_CODES }, () =>
      randomBytes(5).toString('hex'),
    );
    await user.update({
      mfaEnabledAt: new Date(),
      mfaRecoveryCodes: recoveryCodes.map(sha256),
    });
    return { recoveryCodes };
  }

  async verifyCode(
    user: Pick<User, 'id' | 'mfaSecretEnc'>,
    code: string,
  ): Promise<boolean> {
    if (!user.mfaSecretEnc || !/^\d{6}$/.test(code)) return false;
    const lastStepKey = `mfa:last-step:${user.id}`;
    const lastStep = Number((await this.redis.client.get(lastStepKey)) ?? -1);

    const result = await verify({
      secret: this.box.open(user.mfaSecretEnc),
      token: code,
      epochTolerance: 30, // accept one step of clock skew either way
      ...(lastStep >= 0 && { afterTimeStep: lastStep }),
    }).catch(() => ({ valid: false as const }));

    if (!result.valid) return false;
    await this.redis.client.set(
      lastStepKey,
      String((result as { timeStep: number }).timeStep),
      'EX',
      120,
    );
    return true;
  }

  /** Consumes a recovery code (single use). */
  async useRecoveryCode(userId: string, code: string): Promise<boolean> {
    const user = await this.userModel.findByPk(userId);
    const hashes = user?.mfaRecoveryCodes ?? [];
    const candidate = Buffer.from(sha256(code.trim().toLowerCase()));
    const index = hashes.findIndex((h) =>
      timingSafeEqual(Buffer.from(h), candidate),
    );
    if (index < 0 || !user) return false;
    await user.update({
      mfaRecoveryCodes: hashes.filter((_, i) => i !== index),
    });
    return true;
  }
}
