import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  MFA_CHALLENGE_REPOSITORY,
  SECOND_FACTOR_REPOSITORY,
  type MfaChallengeRepository,
  type SecondFactorRepository,
} from '../domain/ports';
import { SecretBox } from '../infra/crypto/secret-box';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/**
 * Housekeeping behind the S49 jobs (`identity.reseal-mfa-secrets`, `identity.purge-expired-pending-mfa`,
 * `identity.purge-mfa-challenges`). Each call is one bounded batch and returns how many rows it handled, so the job
 * repeats until it returns 0 and a crash loses nothing: every step is conditional and idempotent.
 */
@Injectable()
export class MfaMaintenanceService {
  constructor(
    @Inject(SECOND_FACTOR_REPOSITORY)
    private readonly factors: SecondFactorRepository,
    @Inject(MFA_CHALLENGE_REPOSITORY)
    private readonly challenges: MfaChallengeRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly box: SecretBox,
  ) {}

  /** Binds secrets that were migrated without a context to `mfa:<userId>` (R-05). */
  resealSecrets({ batchSize }: { batchSize: number }): Promise<number> {
    return this.factors.resealBatch(
      batchSize,
      (row) =>
        this.box.seal(this.box.open(row.secretSealed), `mfa:${row.userId}`),
      this.clock.now(),
    );
  }

  /** Pending enrolments that expired more than a day ago (expiry itself is lazy and needs no job). */
  purgeExpiredPending({ batchSize }: { batchSize: number }): Promise<number> {
    return this.factors.purgePending(
      new Date(this.clock.nowMs() - DAY),
      batchSize,
    );
  }

  purgeChallenges({ batchSize }: { batchSize: number }): Promise<number> {
    return this.challenges.purge(
      new Date(this.clock.nowMs() - HOUR),
      batchSize,
    );
  }
}
