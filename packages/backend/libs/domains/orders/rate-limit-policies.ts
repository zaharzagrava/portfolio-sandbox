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
  /** Cart writes (S10 FR-010): 120 per minute per user, or per client address for a guest. */
  'orders.cart-write.identity': {
    algorithm: 'slidingWindow',
    limit: 120,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'open',
  },
  'orders.cancel.user': {
    algorithm: 'slidingWindow',
    limit: 20,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
  /** The payment webhook (S10 FR-042): signature-verified, but forged traffic still counts against the address. */
  'orders.webhook.ip': {
    algorithm: 'slidingWindow',
    limit: 300,
    windowMs: 60_000,
    key: 'ip',
    failMode: 'open',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof ordersRatePolicies.policies
  > {}
}
