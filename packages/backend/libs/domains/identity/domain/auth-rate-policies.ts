import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

const HOUR = 3_600_000;

/**
 * Rate limit policies owned by `identity` (S50 FR-050), registered by `AuthApiModule` through
 * `RateLimitModule.forFeature`. `@RateLimit(...)` on a route is metadata only: the global interceptor installed by
 * `RateLimitModule.forRoot()` enforces it. `auth.reset.account` is enforced from code (research R-04) because the
 * request answers 2xx for every address.
 */
export const identityRatePolicies = definePolicies('identity', {
  'auth.register.ip': {
    algorithm: 'slidingWindow',
    limit: 10,
    windowMs: HOUR,
    key: 'ip',
    failMode: 'closed',
  },
  'auth.login.ip': {
    algorithm: 'slidingWindow',
    limit: 20,
    windowMs: 60_000,
    key: 'ip',
    failMode: 'closed',
  },
  'auth.login.account': {
    algorithm: 'slidingWindow',
    limit: 5,
    windowMs: 15 * 60_000,
    key: 'body.email',
    failMode: 'closed',
    count: 'failures-only',
    resetOnSuccess: true,
  },
  'auth.refresh.ip': {
    algorithm: 'slidingWindow',
    limit: 60,
    windowMs: 60_000,
    key: 'ip',
    failMode: 'closed',
  },
  'auth.reset.ip': {
    algorithm: 'slidingWindow',
    limit: 5,
    windowMs: HOUR,
    key: 'ip',
    failMode: 'closed',
  },
  'auth.reset.confirm.ip': {
    algorithm: 'slidingWindow',
    limit: 10,
    windowMs: HOUR,
    key: 'ip',
    failMode: 'closed',
  },
  'auth.reset.account': {
    algorithm: 'slidingWindow',
    limit: 3,
    windowMs: HOUR,
    key: 'body.email',
    failMode: 'closed',
    count: 'failures-only',
    resetOnSuccess: true,
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof identityRatePolicies.policies
  > {}
}
