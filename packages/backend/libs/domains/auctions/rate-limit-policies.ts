import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/** Rate limit policies owned by `auctions` (S50 FR-050): registered by `AuctionsModule`. */
export const auctionsRatePolicies = definePolicies('auctions', {
  'auction.bid': {
    algorithm: 'tokenBucket',
    limit: 10,
    windowMs: 10_000,
    key: 'user',
    failMode: 'closed',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof auctionsRatePolicies.policies
  > {}
}
