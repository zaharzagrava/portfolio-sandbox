import { Injectable } from '@nestjs/common';
import {
  Domain_RateLimitedError,
  Domain_RateLimiterUnavailableError,
  RateLimiterService,
} from '@app/infrastructure/rate-limit';

/**
 * Charges `content.write.shop` (120 per minute per shop, fail closed) from the services (S27 FR-061, AS-94). A denial
 * answers `429` with `Retry-After`; a limiter that cannot answer refuses the write with `503`.
 */
@Injectable()
export class StoryWriteLimit {
  constructor(private readonly limiter: RateLimiterService) {}

  async take(shopId: string): Promise<void> {
    const decision = await this.limiter.check(
      'content.write.shop',
      `shop:${shopId}`,
    );
    if (decision.allowed) return;
    if (decision.reason === 'store-unavailable')
      throw new Domain_RateLimiterUnavailableError();
    const seconds = Math.max(
      Math.ceil((decision.retryAfterMs ?? 1_000) / 1_000),
      1,
    );
    throw new Domain_RateLimitedError(seconds, {
      'Retry-After': String(seconds),
    });
  }
}
