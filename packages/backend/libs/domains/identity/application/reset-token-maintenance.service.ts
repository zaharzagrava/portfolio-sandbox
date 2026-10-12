import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  RESET_TOKEN_REPOSITORY,
  type ResetTokenRepository,
} from '../domain/ports';

const DAY = 86_400_000;

/** Housekeeping behind the S49 job `auth.purge-reset-tokens`: one bounded batch per call, safe to repeat. */
@Injectable()
export class ResetTokenMaintenanceService {
  constructor(
    @Inject(RESET_TOKEN_REPOSITORY)
    private readonly tokens: ResetTokenRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Tokens that expired more than a day ago (spent or not); the digests have no use after that. */
  purgeExpired({ batchSize }: { batchSize: number }): Promise<number> {
    return this.tokens.purgeExpired(
      new Date(this.clock.nowMs() - DAY),
      batchSize,
    );
  }
}
