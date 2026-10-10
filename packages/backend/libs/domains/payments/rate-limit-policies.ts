import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/** Rate limit policies owned by `payments` (S13 FR-052): registered by `PaymentModule` through `RateLimitModule.forFeature`. */
export const paymentsRatePolicies = definePolicies('payments', {
  'payments.create.user': {
    algorithm: 'slidingWindow',
    limit: 10,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
  'payments.read.user': {
    algorithm: 'slidingWindow',
    limit: 120,
    windowMs: 60_000,
    key: 'user',
    failMode: 'open',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof paymentsRatePolicies.policies
  > {}
}
