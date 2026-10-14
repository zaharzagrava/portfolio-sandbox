import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ApiError } from '../domain/errors';
import {
  QuotaAnswer,
  QuotaCache,
  QuotaPort,
  QuotaUnavailable,
} from '../domain/ports';
import { apiMetrics } from './metrics';

export const QUOTA_CACHE_TTL_SEC = 60;
/** Clients re-check at least hourly, however far away the reset is. */
export const QUOTA_RETRY_AFTER_CAP_SEC = 3_600;

/**
 * The monthly plan quota in front of a live key's calls (FR-053): the billing answer is cached per shop for 60 s; a
 * refusal is `429 quota_exceeded` with `Retry-After` capped at an hour; when billing cannot answer the call is served
 * and counted (fail open). Test keys are never limited by the quota and never ask.
 */
@Injectable()
export class QuotaGate {
  private readonly logger = new Logger(QuotaGate.name);

  constructor(
    private readonly port: QuotaPort,
    private readonly cache: QuotaCache,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async assert(key: { liveShopId: string; livemode: boolean }): Promise<void> {
    if (!key.livemode) return;
    const answer = await this.answerFor(key.liveShopId);
    if (!answer || answer.allowed) return;
    const untilReset = Math.ceil(
      (Date.parse(answer.resetsAt) - this.clock.now().getTime()) / 1000,
    );
    throw new ApiError(
      'quota_exceeded',
      `The plan allows ${answer.limit} calls this month and ${answer.used} are used; the allowance renews at ${answer.resetsAt}.`,
      {
        retryAfterSeconds: Math.max(
          1,
          Math.min(QUOTA_RETRY_AFTER_CAP_SEC, untilReset),
        ),
      },
    );
  }

  private async answerFor(shopId: string): Promise<QuotaAnswer | null> {
    const cached = await this.cache.get(shopId).catch(() => null);
    if (cached) return cached;
    try {
      const answer = await this.port.check(shopId);
      await this.cache
        .put(shopId, answer, QUOTA_CACHE_TTL_SEC)
        .catch(() => undefined);
      return answer;
    } catch (error) {
      const reason =
        error instanceof QuotaUnavailable ? error.reason : 'usage_unavailable';
      if (!(error instanceof QuotaUnavailable))
        this.logger.warn(`quota check failed: ${(error as Error).message}`);
      apiMetrics.quotaDegraded().add(1, { reason });
      return null;
    }
  }
}
