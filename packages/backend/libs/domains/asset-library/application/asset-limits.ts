import { Injectable } from '@nestjs/common';
import {
  Domain_RateLimitedError,
  Domain_RateLimiterUnavailableError,
  RateLimiterService,
} from '@app/infrastructure/rate-limit';
import type { assetRatePolicies } from '../rate-limit-policies';
import { assetMetrics } from './asset-metrics';

type AssetPolicy = keyof typeof assetRatePolicies.policies;

/**
 * Charges the limits of S31 FR-046 from the services (S50: `@RateLimit` is metadata only), so they hold in every app.
 * A denial answers `429` with `Retry-After`; a fail-closed policy whose store cannot answer refuses the call (`503`),
 * a fail-open one lets it through (the limiter answers `allowed` then).
 */
@Injectable()
export class AssetLimits {
  constructor(private readonly limiter: RateLimiterService) {}

  /** `subject` is `shop:<id>`, `ip:<address>` or `user:<id>`. */
  async take(policy: AssetPolicy, subject: string): Promise<void> {
    const decision = await this.limiter.check(policy, subject);
    if (decision.allowed) return;
    if (decision.reason === 'store-unavailable')
      throw new Domain_RateLimiterUnavailableError();
    assetMetrics.rateLimited.add(1, { policy });
    const seconds = Math.max(
      Math.ceil((decision.retryAfterMs ?? 1_000) / 1_000),
      1,
    );
    throw new Domain_RateLimitedError(seconds, {
      'Retry-After': String(seconds),
    });
  }
}
