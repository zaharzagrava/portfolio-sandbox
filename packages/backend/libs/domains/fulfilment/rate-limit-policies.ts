import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

const MINUTE = 60_000;

/**
 * Rate limit policies owned by the pickup capability (S19 FR-027, A12): registered by `PickupModule` through
 * `RateLimitModule.forFeature`. Both read paths fail open: a limiter outage must not take "available near me" down.
 * They replace the `search.query` policy and `skipThrottle` the draft controller used (S50 G-35).
 */
export const fulfilmentRatePolicies = definePolicies('fulfilment', {
  // search and exact browse
  'fulfilment.near-search': {
    algorithm: 'slidingWindow',
    limit: 120,
    windowMs: MINUTE,
    key: 'userOrIp',
    failMode: 'open',
  },
  // the map re-queries on every pan; the CDN copy (30 s) absorbs repeats
  'fulfilment.map-clusters': {
    algorithm: 'slidingWindow',
    limit: 300,
    windowMs: MINUTE,
    key: 'ip',
    failMode: 'open',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof fulfilmentRatePolicies.policies
  > {}
}
