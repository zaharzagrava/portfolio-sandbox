import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

const MINUTE = 60_000;

/**
 * Rate limit policies owned by `discovery` search (S32 FR-012, FR-050, FR-053): registered by `ProductSearchModule`
 * through `RateLimitModule.forFeature`. Reads and clicks fail open (a limiter outage must not take search down); the
 * admin routes fail closed. `catalogRatePolicies` keeps declaring `search.query` for its other call sites (G-35).
 */
export const discoveryRatePolicies = definePolicies('discovery', {
  'discovery.search.query': {
    algorithm: 'slidingWindow',
    limit: 120,
    windowMs: MINUTE,
    key: 'userOrIp',
    failMode: 'open',
  },
  // keyed by user and shop: the route supplies the subject
  'discovery.shop-search': {
    algorithm: 'slidingWindow',
    limit: 120,
    windowMs: MINUTE,
    key: 'custom',
    failMode: 'open',
  },
  'discovery.search-click': {
    algorithm: 'slidingWindow',
    limit: 300,
    windowMs: MINUTE,
    key: 'ip',
    failMode: 'open',
  },
  'discovery.search-admin': {
    algorithm: 'slidingWindow',
    limit: 30,
    windowMs: MINUTE,
    key: 'user',
    failMode: 'closed',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof discoveryRatePolicies.policies
  > {}
}
