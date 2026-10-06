import { ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { UniqueConstraintError } from 'sequelize';
import * as jwt from 'jsonwebtoken';
import User, { Role } from '../infra/models/user.model';
import FederatedIdentity from '../infra/models/federated-identity.model';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import { PasswordHasher } from '../infra/crypto/password-hasher';
import { KeyStore } from '../infra/keys/key-store.service';
import { SessionStore } from '../infra/sessions/session-store.service';
import { TotpService } from './mfa/totp.service';
import { OidcIdentity } from '../infra/oidc/oidc.service';
import { PasswordLoginDto, RegisterDto } from '../api/auth.dto';

export interface SessionTokens {
  accessToken: { token: string; expiresIn: number };
  refreshToken: string;
  sessionId: string;
  user: { id: string; email: string | null; role: Role };
}

export type LoginResult = ({ mfaRequired: false } & SessionTokens) | { mfaRequired: true; mfaToken: string };

const MFA_TOKEN_TTL_SEC = 300;

/**
 * Session lifecycle (SD-39): password/OIDC login → (MFA) → session with a
 * short-lived ES256 access token + rotating opaque refresh token. Lives in
 * AuthApiModule; AuthModule (token *verification*) stays lightweight for
 * every app that only checks tokens.
 */
@Injectable()
export class AuthSessionService {
  constructor(
    @InjectModel(User) private readonly userModel: typeof User,
    @InjectModel(FederatedIdentity) private readonly identityModel: typeof FederatedIdentity,
    private readonly config: ApiConfigService,
    private readonly hasher: PasswordHasher,
    private readonly keys: KeyStore,
    private readonly sessions: SessionStore,
    private readonly totp: TotpService,
    private readonly cache: CacheService,
  ) {}

  private get accessTtlSec() {
    return this.config.get('access_token_ttl_sec') ?? 600;
  }

  private get refreshTtlDays() {
    return this.config.get('refresh_token_ttl_days') ?? 30;
  }

  async register(dto: RegisterDto, meta: { device?: string; ip?: string }): Promise<SessionTokens> {
    try {
      const user = await this.userModel.create({
        email: dto.email,
        passwordHash: await this.hasher.hash(dto.password),
        role: dto.role ?? Role.USER,
      });
      return this.issue(user, meta);
    } catch (error) {
      if (error instanceof UniqueConstraintError) throw new ConflictException('Email is already registered');
      throw error;
    }
  }

  async login(dto: PasswordLoginDto, meta: { device?: string; ip?: string }): Promise<LoginResult> {
    const user = await this.userModel.findOne({ where: { email: dto.email } });
    const { valid, needsRehash } = await this.hasher.verify(dto.password, user?.passwordHash);

    // Same error for "no such email" and "wrong password" (no user enumeration, lesson 05/01 §5).
    if (!user || !valid) throw new UnauthorizedException('Invalid email or password');

    // bcrypt → argon2id (or stale argon2 params) transparently, while we have the plaintext.
    if (needsRehash) await user.update({ passwordHash: await this.hasher.hash(dto.password) });

    if (user.mfaEnabledAt) {
      const mfaToken = await this.keys.sign({ sub: user.id, purpose: 'mfa' }, { expiresInSec: MFA_TOKEN_TTL_SEC, audience: 'mfa' });
      return { mfaRequired: true, mfaToken };
    }
    return { mfaRequired: false, ...(await this.issue(user, meta)) };
  }

  async completeMfa(mfaToken: string, code: string, meta: { device?: string; ip?: string }): Promise<SessionTokens> {
    let sub: string;
    try {
      const header = jwt.decode(mfaToken, { complete: true })?.header;
      const key = header?.kid ? await this.keys.verificationKey(header.kid) : undefined;
      if (!key) throw new Error('unknown key');
      const payload = jwt.verify(mfaToken, key.key, { algorithms: [key.alg], audience: 'mfa', issuer: 'marketplace' }) as { sub: string; purpose: string };
      if (payload.purpose !== 'mfa') throw new Error('wrong purpose');
      sub = payload.sub;
    } catch {
      throw new UnauthorizedException('Invalid or expired MFA challenge');
    }

    const user = await this.userModel.findByPk(sub);
    if (!user) throw new UnauthorizedException('Invalid or expired MFA challenge');
    const ok = /^\d{6}$/.test(code) ? await this.totp.verifyCode(user, code) : await this.totp.useRecoveryCode(user.id, code);
    if (!ok) throw new UnauthorizedException('Invalid code');
    return this.issue(user, meta);
  }

  async refresh(refreshToken: string): Promise<SessionTokens> {
    const result = await this.sessions.rotate(refreshToken, this.refreshTtlDays, Number(this.config.get('auth_refresh_reuse_grace_ms') ?? 10_000));
    if (!result.ok) {
      throw new UnauthorizedException(result.reason === 'reuse_detected' ? 'Refresh token reuse detected - session revoked' : 'Invalid refresh token');
    }
    const user = await this.userModel.findByPk(result.session.userId);
    if (!user) throw new UnauthorizedException('Invalid refresh token');
    return {
      accessToken: await this.accessToken(user, result.session.sid),
      refreshToken: result.refreshToken,
      sessionId: result.session.sid,
      user: { id: user.id, email: user.email, role: user.role },
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId, 'logout', this.accessTtlSec);
  }

  async logoutAll(userId: string): Promise<number> {
    const count = await this.sessions.revokeAllForUser(userId, 'logout_all', this.accessTtlSec);
    await this.cache.invalidate([`auth:user:v1:${userId}`]);
    return count;
  }

  /**
   * OIDC login: existing (provider, subject) link → that user. Otherwise link
   * to an existing account by email ONLY if the IdP says the email is
   * verified (else anyone could register `victim@mail.com` at a lax IdP and
   * take over the account), or create a new user.
   */
  async loginWithOidc(identity: OidcIdentity, meta: { device?: string; ip?: string }): Promise<SessionTokens> {
    const link = await this.identityModel.findOne({ where: { provider: identity.provider, subject: identity.subject } });
    let user = link ? await this.userModel.findByPk(link.userId) : null;

    if (!user) {
      if (identity.email && !identity.emailVerified) throw new ForbiddenException('Email not verified by the identity provider');
      user = identity.email ? await this.userModel.findOne({ where: { email: identity.email } }) : null;
      user ??= await this.userModel.create({ email: identity.email ?? null, passwordHash: null, role: Role.USER });
      await this.identityModel.create({ userId: user.id, provider: identity.provider, subject: identity.subject, email: identity.email ?? null });
    }
    return this.issue(user, meta);
  }

  private async issue(user: User, meta: { device?: string; ip?: string }): Promise<SessionTokens> {
    const { session, refreshToken } = await this.sessions.create(user.id, this.refreshTtlDays, meta);
    return {
      accessToken: await this.accessToken(user, session.sid),
      refreshToken,
      sessionId: session.sid,
      user: { id: user.id, email: user.email, role: user.role },
    };
  }

  private async accessToken(user: User, sid: string) {
    const token = await this.keys.sign({ sub: user.id, role: user.role, sid }, { expiresInSec: this.accessTtlSec });
    return { token, expiresIn: this.accessTtlSec };
  }
}
