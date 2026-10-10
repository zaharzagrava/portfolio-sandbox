import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/** Rate limit policies owned by `developer-platform` (S50 FR-050): registered by `PublicApiModule`. */
export const developerPlatformRatePolicies = definePolicies(
  'developer-platform',
  {
    'public-api.default': {
      algorithm: 'tokenBucket',
      limit: 6000,
      windowMs: 60_000,
      key: 'apiKey',
      failMode: 'open',
      localLeaseFraction: 0.05,
    },
  } as const,
);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof developerPlatformRatePolicies.policies
  > {}
}
