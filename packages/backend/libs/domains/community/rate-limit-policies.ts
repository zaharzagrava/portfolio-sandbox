import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/**
 * Rate limit policies owned by `community` (S50 FR-050): registered by `DiscussionsModule` (discussions) and `FeedModule`
 * (`follow.write`, `feed.read`; S26 FR-010). The same table imported by two modules registers once.
 */
export const communityRatePolicies = definePolicies('community', {
  /** Follow and unfollow: 30 per minute per user; refuses when the limiter store is down. */
  'follow.write': {
    algorithm: 'tokenBucket',
    limit: 30,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
  /** Feed and follow-status reads: 120 per minute per user; serves when the limiter store is down. */
  'feed.read': {
    algorithm: 'tokenBucket',
    limit: 120,
    windowMs: 60_000,
    key: 'user',
    failMode: 'open',
  },
  'discussion.write': {
    algorithm: 'tokenBucket',
    limit: 10,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
  'discussion.vote': {
    algorithm: 'tokenBucket',
    limit: 60,
    windowMs: 60_000,
    key: 'user',
    failMode: 'open',
    localLeaseFraction: 0.1,
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof communityRatePolicies.policies
  > {}
}
