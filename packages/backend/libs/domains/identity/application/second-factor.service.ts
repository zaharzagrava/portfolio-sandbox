import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  MFA_CHALLENGE_REPOSITORY,
  SECOND_FACTOR_REPOSITORY,
  USER_REPOSITORY,
  type MfaChallengeRepository,
  type SecondFactorRepository,
  type SecondFactorRow,
  type UserRepository,
} from '../domain/ports';
import {
  Domain_InvalidCodeError,
  Domain_InvalidMfaChallengeError,
  Domain_InvalidMfaCodeError,
  Domain_MfaAlreadyEnabledError,
  Domain_MfaNotPendingError,
} from '../domain/errors';
import { MfaEnabled, MfaRecoveryCodeUsed } from '../domain/events';
import {
  generateRecoveryCodes,
  normaliseRecoveryCode,
} from '../domain/recovery-code';
import { nextState } from '../domain/second-factor-state';
import { generateSecret, otpauthUri, verifyTotp } from '../domain/totp';
import { SecretBox } from '../infra/crypto/secret-box';
import { MfaAttemptBudget } from './mfa-attempt-budget';

export const TOTP_ISSUER = 'Marketplace';
export const PENDING_ENROLMENT_MS = 15 * 60_000;
export const MAX_CHALLENGE_ATTEMPTS = 3;
const RECOVERY_PURPOSE = 'mfa-recovery';

export interface SecondFactorStatus {
  state: 'none' | 'pending' | 'enabled';
  enabledAt?: string;
  recoveryCodesRemaining?: number;
}

/**
 * The user's TOTP second factor: the none → pending → enabled state machine, the confirmation that issues the
 * recovery codes, and the code check at login. Every guard is a conditional statement in the store (replay,
 * single-use challenge, spent recovery code, concurrent confirm), never a read followed by a write (III.6, III.7).
 */
@Injectable()
export class SecondFactorService {
  constructor(
    @Inject(SECOND_FACTOR_REPOSITORY)
    private readonly factors: SecondFactorRepository,
    @Inject(MFA_CHALLENGE_REPOSITORY)
    private readonly challenges: MfaChallengeRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly box: SecretBox,
    private readonly budget: MfaAttemptBudget,
    private readonly transactions: TransactionRunner,
    private readonly outbox: OutboxService,
  ) {}

  /** True only for an `enabled` factor: a pending enrolment never changes how login works (S01 FR-015). */
  async isSecondFactorEnrolled(userId: string): Promise<boolean> {
    return (
      (await this.factors.find(userId, this.clock.now()))?.state === 'enabled'
    );
  }

  async status(userId: string): Promise<SecondFactorStatus> {
    const row = await this.factors.find(userId, this.clock.now());
    if (!row) return { state: 'none' };
    if (row.state === 'pending') return { state: 'pending' };
    return {
      state: 'enabled',
      enabledAt: row.enabledAt?.toISOString(),
      recoveryCodesRemaining: await this.factors.remainingCodes(userId),
    };
  }

  /** `none | pending → pending`: a new secret and a new 15-minute expiry. An enabled factor is never replaced. */
  async enrol(
    userId: string,
  ): Promise<{ otpauthUri: string; manualEntryKey: string }> {
    const now = this.clock.now();
    const current = await this.factors.find(userId, now);
    if (nextState(current?.state ?? 'none', 'enrol') === null)
      throw new Domain_MfaAlreadyEnabledError();

    const user = await this.users.findById(userId);
    const secret = generateSecret();
    const stored = await this.factors.enrol({
      userId,
      secretSealed: this.box.seal(secret, this.context(userId)),
      expiresAt: new Date(now.getTime() + PENDING_ENROLMENT_MS),
      now,
    });
    // The factor became enabled between the read and the write: the store refused to replace it.
    if (!stored) throw new Domain_MfaAlreadyEnabledError();
    return {
      otpauthUri: otpauthUri({
        issuer: TOTP_ISSUER,
        label: user?.email ?? userId,
        secret,
      }),
      manualEntryKey: secret,
    };
  }

  /** `pending → enabled` with a valid code; returns the ten recovery codes, shown once. */
  async confirm(userId: string, code: string): Promise<string[]> {
    const now = this.clock.now();
    const row = await this.factors.find(userId, now);
    if (!row || nextState(row.state, 'confirm') === null)
      throw new Domain_MfaNotPendingError();

    const secret = this.openSecret(row);
    await this.budget.take(userId);
    const check = verifyTotp({
      secret,
      code,
      nowMs: now.getTime(),
      lastStep: row.lastStep,
    });
    if (!check.valid) throw new Domain_InvalidCodeError();

    const recoveryCodes = generateRecoveryCodes();
    try {
      await this.transactions.run(async () => {
        if (!(await this.factors.confirm(userId, check.step, now)))
          throw new Domain_MfaNotPendingError();
        await this.factors.replaceCodes(
          userId,
          recoveryCodes.map((c) => this.digest(c)),
          now,
        );
        await this.outbox.append(
          MfaEnabled.create(userId, this.clock.nowMs(), { userId }),
        );
      });
    } catch (error) {
      // The state moved under us (another confirm won, or the enrolment expired): the code was not the problem.
      if (error instanceof Domain_MfaNotPendingError)
        await this.budget.refund(userId);
      throw error;
    }
    await this.budget.succeeded(userId);
    return recoveryCodes;
  }

  /**
   * Checks the code of a login challenge and spends what it must: the challenge, and the TOTP step or the recovery
   * code, in one transaction (both succeed or neither). Returns which kind of code won. The caller issues the session
   * after this returns (the commit is behind us; DynamoDB is network I/O).
   */
  async verifyForLogin(input: {
    userId: string;
    jti: string;
    challengeExpiresAt: Date;
    code: string;
  }): Promise<'otp' | 'rcv'> {
    const now = this.clock.now();
    const row = await this.factors.find(input.userId, now);
    if (!row || row.state !== 'enabled')
      throw new Domain_InvalidMfaChallengeError();

    const isTotp = /^[0-9]{6}$/.test(input.code);
    const recovery = isTotp ? null : normaliseRecoveryCode(input.code);
    // An unopenable secret is a server fault: nothing has been taken from the budget or the challenge yet.
    const secret = isTotp ? this.openSecret(row) : null;

    await this.budget.take(input.userId);
    const attempt = await this.challenges.reserveAttempt({
      jti: input.jti,
      userId: input.userId,
      expiresAt: input.challengeExpiresAt,
      max: MAX_CHALLENGE_ATTEMPTS,
    });
    if (attempt === null) {
      await this.budget.refund(input.userId);
      throw new Domain_InvalidMfaChallengeError();
    }

    let method: 'otp' | 'rcv';
    if (secret !== null) {
      const check = verifyTotp({
        secret,
        code: input.code,
        nowMs: now.getTime(),
        lastStep: row.lastStep,
      });
      if (!check.valid) throw new Domain_InvalidMfaCodeError();
      await this.transactions.run(async () => {
        // A step already taken by a parallel request (or another challenge) is a replay.
        if (!(await this.factors.acceptStep(input.userId, check.step, now)))
          throw new Domain_InvalidMfaCodeError();
        if (!(await this.challenges.spend(input.jti, now)))
          throw new Domain_InvalidMfaChallengeError();
      });
      method = 'otp';
    } else if (recovery !== null) {
      await this.transactions.run(async () => {
        if (
          !(await this.factors.spendCode(
            input.userId,
            this.digest(recovery),
            now,
          ))
        )
          throw new Domain_InvalidMfaCodeError();
        if (!(await this.challenges.spend(input.jti, now)))
          throw new Domain_InvalidMfaChallengeError();
        await this.outbox.append(
          MfaRecoveryCodeUsed.create(input.userId, this.clock.nowMs(), {
            userId: input.userId,
            remaining: await this.factors.remainingCodes(input.userId),
          }),
        );
      });
      method = 'rcv';
    } else {
      throw new Domain_InvalidMfaCodeError();
    }
    await this.budget.succeeded(input.userId);
    return method;
  }

  /**
   * A fresh TOTP code of an `enabled` factor, taken through the same step guard and attempt budget (step-up of the
   * explicit link and, later, regenerate and disable). `invalid_code` for any mismatch.
   */
  async consumeTotpCode(userId: string, code: string): Promise<void> {
    const now = this.clock.now();
    const row = await this.factors.find(userId, now);
    if (!row || row.state !== 'enabled') throw new Domain_MfaNotPendingError();
    const secret = this.openSecret(row);
    await this.budget.take(userId);
    const check = verifyTotp({
      secret,
      code,
      nowMs: now.getTime(),
      lastStep: row.lastStep,
    });
    if (
      !check.valid ||
      !(await this.factors.acceptStep(userId, check.step, now))
    )
      throw new Domain_InvalidCodeError();
    await this.budget.succeeded(userId);
  }

  private context(userId: string): string {
    return `mfa:${userId}`;
  }

  private openSecret(row: SecondFactorRow): string {
    return row.sealVersion === 0
      ? this.box.open(row.secretSealed)
      : this.box.open(row.secretSealed, this.context(row.userId));
  }

  private digest(code: string): string {
    return this.box.keyedDigest(
      RECOVERY_PURPOSE,
      normaliseRecoveryCode(code) ?? code,
    );
  }
}
