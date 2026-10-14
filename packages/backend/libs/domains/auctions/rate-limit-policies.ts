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
  /** S21 FR-033: anonymous public reads of an auction and its bid history, per address. */
  'auctions.read.ip': {
    algorithm: 'slidingWindow',
    limit: 600,
    windowMs: 60_000,
    key: 'ip',
    failMode: 'open',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof auctionsRatePolicies.policies
  > {}
}
