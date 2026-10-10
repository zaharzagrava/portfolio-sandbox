import type { RateLimitPolicy } from './rate-limit.types';

/** A capability's policy declarations, registered with `RateLimitModule.forFeature(table)` (FR-050). */
export interface PolicyTable<
  T extends Record<string, RateLimitPolicy> = Record<string, RateLimitPolicy>,
> {
  owner: string;
  policies: T;
}

/**
 * Declares an owner's policies. `satisfies`-style typing keeps the literal names; the owner then adds them to the
 * name union with a module augmentation next to the call (see `PolicyNameRegistry`), so `@RateLimit('typo')` and
 * `check('typo', ...)` do not compile (P0113, AS-72).
 */
export function definePolicies<const T extends Record<string, RateLimitPolicy>>(
  owner: string,
  policies: T,
): PolicyTable<T> {
  return { owner, policies };
}
