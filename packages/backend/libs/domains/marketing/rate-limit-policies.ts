import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/** Rate limit policies owned by `marketing` share links (S37 G8, S50 follow-up): registered by `ShareLinksModule`. */
export const marketingRatePolicies = definePolicies('marketing', {
  'share-link.create': {
    algorithm: 'tokenBucket',
    limit: 20,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof marketingRatePolicies.policies
  > {}
}
