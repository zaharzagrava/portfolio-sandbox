import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/** Rate limit policies owned by `orders` (S50 FR-050): registered by `OrdersModule` through `RateLimitModule.forFeature`. */
export const ordersRatePolicies = definePolicies('orders', {
  'checkout.create': {
    algorithm: 'tokenBucket',
    limit: 10,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof ordersRatePolicies.policies
  > {}
}
