import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  Domain_RateLimitedError,
  Domain_RateLimiterUnavailableError,
  RateLimiterService,
} from '@app/infrastructure/rate-limit';
import {
  BREACH_CHECKER,
  PASSWORD_HASHER,
  PASSWORD_RESET_MAILER,
  RESET_TOKEN_REPOSITORY,
  USER_REPOSITORY,
  type BreachCheckerPort,
  type PasswordHasherPort,
  type PasswordResetMailer,
  type ResetTokenRepository,
  type UserRepository,
} from '../domain/ports';
import {
  Domain_InvalidResetTokenError,
  Domain_WeakPasswordError,
} from '../domain/errors';
import { PasswordChanged } from '../domain/events';
import { normalizeEmail, passwordProblem } from '../domain/password-policy';
import { AuditService } from './audit.service';
import { SessionRevocationService } from './session-revocation.service';

export const RESET_TOKEN_TTL_MS = 30 * 60_000;

const digestOf = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/**
 * Password reset (S01 FR-080..FR-084). The request answers the same for every address; for a known one it stores only
 * the SHA-256 digest of a 32-byte token and mails the link directly (the raw token is in no table, outbox row or log).
 * Confirm spends the token, sets the password and ends every session of the user.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(RESET_TOKEN_REPOSITORY) private readonly tokens: ResetTokenRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(BREACH_CHECKER) private readonly breach: BreachCheckerPort,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional()
    @Inject(PASSWORD_RESET_MAILER)
    private readonly mailer: PasswordResetMailer | undefined,
    private readonly transactions: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly revocation: SessionRevocationService,
    private readonly limiter: RateLimiterService,
    private readonly audit: AuditService,
    private readonly config: ApiConfigService,
  ) {}

  async request(rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    await this.takeAccountSlot(email);
    const user = await this.users.findByEmail(email);
    if (!user?.email || !user.passwordHash) {
      digestOf(randomBytes(32).toString('base64url')); // the same hashing work as the known path
      return;
    }
    const token = randomBytes(32).toString('base64url');
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_MS);
    await this.transactions.run(() =>
      this.tokens.issue({
        userId: user.id,
        digest: digestOf(token),
        expiresAt,
        now,
      }),
    );
    this.deliver(user.email, token, expiresAt);
  }

  /** Not awaited: the answer must not depend on (or reveal) whether a mail was sent. */
  private deliver(to: string, token: string, expiresAt: Date): void {
    if (!this.mailer) {
      this.logger.warn('no password reset mailer is bound; mail not sent');
      return;
    }
    const link = `${this.config.get('front_host').replace(/\/$/, '')}/reset-password#token=${token}`;
    this.mailer
      .sendResetLink({ to, link, expiresAt })
      .catch((error: Error) =>
        this.logger.warn(`password reset mail failed: ${error.message}`),
      );
  }

  async confirm(token: string, password: string): Promise<void> {
    const digest = digestOf(token);
    const userId = await this.tokens.find(digest, this.clock.now());
    if (!userId) throw new Domain_InvalidResetTokenError();
    const user = await this.users.findById(userId);
    if (!user) throw new Domain_InvalidResetTokenError();

    const problem = passwordProblem(password, user.email);
    if (problem) throw new Domain_WeakPasswordError(problem);
    if (await this.isBreached(password))
      throw new Domain_WeakPasswordError('breached');
    const passwordHash = await this.hasher.hash(password);

    await this.transactions.run(async () => {
      if (!(await this.tokens.consume(digest, this.clock.now())))
        throw new Domain_InvalidResetTokenError();
      if (!(await this.users.setPasswordHash(userId, passwordHash)))
        throw new Domain_InvalidResetTokenError();
      await this.outbox.append(
        PasswordChanged.create(userId, this.clock.nowMs(), { userId }),
      );
    });
    await this.revocation.revokeAllForUser(userId, 'password_reset');
  }

  private async isBreached(password: string): Promise<boolean> {
    try {
      return await this.breach.isBreached(password);
    } catch {
      this.audit.breachCheckSkipped();
      return false;
    }
  }

  /** `auth.reset.account`: counted for every address, known or not, so the 429 reveals nothing. */
  private async takeAccountSlot(email: string): Promise<void> {
    const decision = await this.limiter.check('auth.reset.account', email);
    if (decision.allowed) return;
    if (decision.reason === 'store-unavailable')
      throw new Domain_RateLimiterUnavailableError({
        'Cache-Control': 'no-store',
        'Retry-After': '1',
      });
    const seconds = Math.max(
      1,
      Math.ceil((decision.retryAfterMs ?? 1000) / 1000),
    );
    throw new Domain_RateLimitedError(seconds, {
      'Cache-Control': 'no-store',
      'Retry-After': String(seconds),
    });
  }
}
