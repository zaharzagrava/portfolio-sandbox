import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

const MINUTE = 60_000;

/**
 * Rate limit policies of the pickup capability (S19 FR-027, A12) and the delivery capability (S20 FR-012, FR-033,
 * contracts/delivery-api.md): registered by `PickupModule` and `DeliveryModule` through
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
  // S20: a phone sends a batch every ~4 s; 30 a minute leaves room for retries and a reconnect burst
  'fulfilment.courier-locations': {
    algorithm: 'slidingWindow',
    limit: 30,
    windowMs: MINUTE,
    key: 'user',
    failMode: 'open',
  },
  // S20: creates a booking, so a limiter outage must not let requests through unmetered
  'fulfilment.delivery-request': {
    algorithm: 'slidingWindow',
    limit: 60,
    windowMs: MINUTE,
    key: 'shop',
    failMode: 'closed',
  },
  // S20: accept, decline, picked-up, delivered, cancel and the role reads
  'fulfilment.delivery-actions': {
    algorithm: 'slidingWindow',
    limit: 120,
    windowMs: MINUTE,
    key: 'user',
    failMode: 'open',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof fulfilmentRatePolicies.policies
  > {}
}
