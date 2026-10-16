import { Injectable } from '@nestjs/common';
import {
  Domain_RateLimitedError,
  RateLimiterService,
} from '@app/infrastructure/rate-limit';
import { launchMetrics } from '../launch-metrics';

export type LaunchPolicy =
  'launch.queue.join.user' | 'launch.hold.user' | 'launch.seatmap.ip';

/**
 * Charges the three S22 policies from the services (the limiter's own interceptor is not used, so the answer to a
 * limiter outage is this capability's: a hold is refused with `HOLDS_UNAVAILABLE`, a join and a seat-map read go on).
 */
@Injectable()
export class LaunchLimits {
  constructor(private readonly limiter: RateLimiterService) {}

  /**
   * Throws `429` with `Retry-After` when over the limit. Returns `'unavailable'` when the limiter could not answer and
   * the policy fails closed (the caller refuses), `'degraded'` when it failed open, `'ok'` otherwise.
   */
  async take(
    policy: LaunchPolicy,
    subject: string,
  ): Promise<'ok' | 'degraded' | 'unavailable'> {
    let decision;
    try {
      decision = await this.limiter.check(policy, subject);
    } catch {
      launchMetrics.limiterFailures.add(1, { policy });
      return policy === 'launch.hold.user' ? 'unavailable' : 'degraded';
    }
    if (decision.allowed) {
      if (decision.source === 'fallback') {
        launchMetrics.limiterFailures.add(1, { policy });
        return 'degraded';
      }
      return 'ok';
    }
    if (decision.reason === 'store-unavailable') {
      launchMetrics.limiterFailures.add(1, { policy });
      return 'unavailable';
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
