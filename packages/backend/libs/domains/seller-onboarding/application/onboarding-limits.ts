import { Injectable } from '@nestjs/common';
import {
  Domain_RateLimitedError,
  Domain_RateLimiterUnavailableError,
  RateLimiterService,
} from '@app/infrastructure/rate-limit';
import type { onboardingRatePolicies } from '../rate-limit-policies';

type OnboardingPolicy = keyof typeof onboardingRatePolicies.policies;

/**
 * Charges the per-shop limits of S04 FR-015 from the services (S50: `@RateLimit` is metadata only), so they hold in
 * every app. Both policies fail closed: a store that cannot answer refuses the call (`503`, never a free pass).
 */
@Injectable()
export class OnboardingLimits {
  constructor(private readonly limiter: RateLimiterService) {}

  async take(policy: OnboardingPolicy, shopId: string): Promise<void> {
    const decision = await this.limiter.check(policy, `shop:${shopId}`);
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
