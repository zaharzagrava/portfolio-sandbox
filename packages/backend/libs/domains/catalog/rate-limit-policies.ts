import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/** Rate limit policies owned by `catalog` (S50 FR-050): registered by `ProductModule` through `RateLimitModule.forFeature`. */
export const catalogRatePolicies = definePolicies('catalog', {
  'search.query': {
    algorithm: 'tokenBucket',
    limit: 60,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'open',
    localLeaseFraction: 0.1,
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof catalogRatePolicies.policies
  > {}
}
