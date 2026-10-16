import { Injectable } from '@nestjs/common';
import {
  Domain_RateLimitedError,
  RateLimiterService,
} from '@app/infrastructure/rate-limit';
import { liveMetrics } from './live-metrics';

export type LivePolicy =
  'live.comment' | 'live.reaction' | 'live.snapshot.ip' | 'live.events.ip';

/**
 * Charges the four live policies from the services (the limiter's own interceptor is not used, so the answer to a limiter
 * outage is this capability's: every live policy fails open and the outage is counted, FR-021, FR-033, FR-047).
 */
@Injectable()
export class LiveLimits {
  constructor(private readonly limiter: RateLimiterService) {}

  /** Throws `429` with `Retry-After` when over the limit; a limiter that cannot answer lets the request through. */
  async take(policy: LivePolicy, subject: string): Promise<void> {
    let decision;
    try {
      decision = await this.limiter.check(policy, subject);
    } catch {
      liveMetrics.limiterUnavailable.add(1, { policy });
      return;
    }
    if (decision.allowed) {
      if (decision.source === 'fallback')
        liveMetrics.limiterUnavailable.add(1, { policy });
      return;
    }
    if (decision.reason === 'store-unavailable') {
      liveMetrics.limiterUnavailable.add(1, { policy });
      return;
    }
    const seconds = Math.max(
      Math.ceil((decision.retryAfterMs ?? 1_000) / 1_000),
      1,
    );
    throw new Domain_RateLimitedError(seconds, {
      'Retry-After': String(seconds),
    });
  }
}
