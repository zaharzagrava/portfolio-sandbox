/**
 * Public entry point of the rate limiter (constitution X.4). Callers import from `@app/infrastructure/rate-limit` only.
 * Registered as the spec's "Provides" list (FR-056): the service, the decorators, the module, the registry helpers, the
 * error classes and the types.
 */
export { RateLimiterService } from './rate-limiter.service';
export { RateLimit, RateLimitExempt } from './rate-limit.decorator';
export type {
  RateLimitArg,
  RateLimitRouteOptions,
} from './rate-limit.decorator';
export { RateLimitModule } from './rate-limit.module';
export { definePolicies } from './policy';
export type { PolicyTable } from './policy';
export {
  Domain_RateLimitCostExceededError,
  Domain_RateLimitedError,
  Domain_RateLimiterUnavailableError,
  InvalidPenaltyError,
  InvalidRateLimitCostError,
  UnsupportedPenaltyError,
} from './rate-limit.errors';
export type {
  AcquireResult,
  PolicyNameRegistry,
  PolicyNamesOf,
  RateLimitAlgorithm,
  RateLimitDecision,
  RateLimitKeySource,
  RateLimitPolicy,
  RateLimitPolicyName,
} from './rate-limit.types';
