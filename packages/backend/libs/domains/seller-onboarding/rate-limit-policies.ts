import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/**
 * Rate limit policies owned by `seller-onboarding` (S50, S04 FR-090). Both are checked in code by the services (S50:
 * `@RateLimit` is metadata only), so they hold in every app, and both fail closed: a model call costs money and a
 * submit starts a human review.
 */
export const onboardingRatePolicies = definePolicies('seller-onboarding', {
  'onboarding.upload.shop': {
    algorithm: 'slidingWindow',
    limit: 20,
    windowMs: 3_600_000,
    key: 'shop',
    failMode: 'closed',
  },
  'onboarding.submit.shop': {
    algorithm: 'slidingWindow',
    limit: 10,
    windowMs: 86_400_000,
    key: 'shop',
    failMode: 'closed',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof onboardingRatePolicies.policies
  > {}
}
