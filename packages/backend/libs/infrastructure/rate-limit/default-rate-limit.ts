import type { RateLimitRouteOptions } from './rate-limit.decorator';

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/** The limit a route gets when it declares neither `@RateLimit` nor `@RateLimitExempt` (FR-047). */
export const defaultEntryFor = (method: string): RateLimitRouteOptions => ({
  policy: SAFE_METHODS.has(method.toUpperCase())
    ? 'default.read'
    : 'default.write',
});
