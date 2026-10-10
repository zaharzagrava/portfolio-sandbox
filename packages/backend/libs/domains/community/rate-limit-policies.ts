import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/** Rate limit policies owned by `community` (S50 FR-050): registered by `DiscussionsModule`. */
export const communityRatePolicies = definePolicies('community', {
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
