import { Inject, Injectable } from '@nestjs/common';
import {
  PASSWORD_HASHER,
  USER_REPOSITORY,
  type PasswordHasherPort,
  type SessionMeta,
  type UserRepository,
} from '../domain/ports';
import { Domain_InvalidCredentialsError } from '../domain/errors';
import { normalizeEmail } from '../domain/password-policy';
import { AuditService } from './audit.service';
import { IssuedSession, SessionIssuer } from './session-issuer.service';

export type LoginResult =
  | ({ mfaRequired: false } & IssuedSession)
  | { mfaRequired: true; mfaToken: string };

/**
 * Password login. One password verification happens whether or not the address exists (a placeholder hash stands in),
 * and every failure is the same `invalid_credentials` (FR-010). Throttling by failures is the S50 interceptor's job
 * (`@RateLimit` on the route); this service only has to answer 401 for a failure.
 */
@Injectable()
export class LoginService {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    private readonly issuer: SessionIssuer,
    private readonly audit: AuditService,
  ) {}

  async login(
    input: { email: string; password: string; delivery?: 'body' | 'cookie' },
    meta: SessionMeta,
  ): Promise<LoginResult> {
    const email = normalizeEmail(input.email);
    const user = await this.users.findByEmail(email);
    const { valid, needsRehash } = await this.hasher.verify(
      input.password,
      user?.passwordHash,
    );
    if (!user || !valid) {
      this.audit.record('auth.login.failed', {
        subject: user ? user.id : `unknown:${this.audit.tag(email)}`,
      });
      throw new Domain_InvalidCredentialsError();
    }

    // bcrypt → Argon2id (or stale parameters) while we hold the plaintext; conditional on the old hash so a password
    // changed in the meantime is not overwritten.
    if (needsRehash && user.passwordHash) {
      await this.users.replacePasswordHash(
        user.id,
        user.passwordHash,
        await this.hasher.hash(input.password),
      );
    }

    if (user.mfaEnabled)
      return {
        mfaRequired: true,
        mfaToken: await this.issuer.createChallenge(user.id),
      };

    const session = await this.issuer.issue({
      userId: user.id,
      amr: ['pwd'],
      delivery: input.delivery,
      meta,
    });
    this.audit.record('auth.login.succeeded', { userId: user.id });
    return { mfaRequired: false, ...session };
  }
}
