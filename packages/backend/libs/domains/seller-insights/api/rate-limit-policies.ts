import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/**
 * Rate limit policies owned by `seller-insights` (S50 FR-050): the public top list, 60 requests a minute per client
 * address. It serves cacheable public data, so it fails open when the limiter store is down (S40 FR-015).
 */
export const sellerInsightsRatePolicies = definePolicies('seller-insights', {
  'seller-insights.leaderboard-read.ip': {
    algorithm: 'slidingWindow',
    limit: 60,
    windowMs: 60_000,
    key: 'ip',
    failMode: 'open',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof sellerInsightsRatePolicies.policies
  > {}
}
