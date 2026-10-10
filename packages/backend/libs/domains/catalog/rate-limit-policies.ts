import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

const MINUTE = 60_000;

/**
 * Rate limit policies owned by `catalog` (S50 FR-050): registered by `ProductModule` through
 * `RateLimitModule.forFeature`. Reads fail open (a limiter outage must not take the product page down); writes fail
 * closed and are counted per shop, so one noisy shop cannot starve the others.
 */
export const catalogRatePolicies = definePolicies('catalog', {
  'catalog.product-read.ip': {
    algorithm: 'slidingWindow',
    limit: 600,
    windowMs: MINUTE,
    key: 'ip',
    failMode: 'open',
  },
  'catalog.product-write.shop': {
    algorithm: 'slidingWindow',
    limit: 120,
    windowMs: MINUTE,
    key: 'shop',
    failMode: 'closed',
  },
  'catalog.batch-read.ip': {
    algorithm: 'slidingWindow',
    limit: 120,
    windowMs: MINUTE,
    key: 'ip',
    failMode: 'open',
  },
  // TRANSITIONAL: five other domains (experimentation, catalog-sync, fulfilment, discovery, launch-events) still use
  // this name and S32 has not declared it yet. The catalog's own routes no longer use it.
  'search.query': {
    algorithm: 'tokenBucket',
    limit: 60,
    windowMs: MINUTE,
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
