import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/**
 * Rate limit policies owned by `content` (S50, S27 FR-061). Charged in code by the services (S50: `@RateLimit` is
 * metadata only), so they hold in every app. Staff writes fail closed: a limiter outage refuses the write (`503`)
 * rather than allowing it. Reads and the public routes are not limited by this policy.
 */
export const storyRatePolicies = definePolicies('content', {
  'content.write.shop': {
    algorithm: 'slidingWindow',
    limit: 120,
    windowMs: 60_000,
    key: 'shop',
    failMode: 'closed',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof storyRatePolicies.policies
  > {}
}
