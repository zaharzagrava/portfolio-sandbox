import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/**
 * Rate limit policies owned by the BFF (S50 follow-up, S48 FR-013, FR-035, FR-049).
 * - the page and the GraphQL cost budget are keyed by the session user, else the client address, and fail open (a
 *   limiter outage must not take the storefront down: the upstream bulkheads still bound the work);
 * - the login policy is keyed by client address and fails closed: credential guessing must not outlive the limiter.
 */
export const bffRatePolicies = definePolicies('bff', {
  'bff.product-page.principal': {
    algorithm: 'slidingWindow',
    limit: 300,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'open',
  },
  'bff.cart-page.principal': {
    algorithm: 'slidingWindow',
    limit: 300,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'open',
  },
  'bff.order-page.principal': {
    algorithm: 'slidingWindow',
    limit: 300,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'open',
  },
  'bff.seller-overview.principal': {
    algorithm: 'slidingWindow',
    limit: 300,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'open',
  },
  'bff.graphql.cost': {
    algorithm: 'tokenBucket',
    limit: 20_000,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'open',
  },
  'bff.session.login.ip': {
    algorithm: 'slidingWindow',
    limit: 20,
    windowMs: 60_000,
    key: 'ip',
    failMode: 'closed',
  },
});

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof bffRatePolicies.policies
  > {}
}
