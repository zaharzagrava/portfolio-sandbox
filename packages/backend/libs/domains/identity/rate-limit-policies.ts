import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/** Rate limit policies owned by `identity` (S50 FR-050): registered by `AuthApiModule` through `RateLimitModule.forFeature`. */
export const identityRatePolicies = definePolicies('identity', {
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
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof identityRatePolicies.policies
  > {}
}
