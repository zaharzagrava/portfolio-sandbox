import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/**
 * Rate limit policies owned by `shop-functions` (S50 FR-050): 10 version submissions an hour per shop (S45 FR-012). A
 * submission queues work for the judge, so a limiter outage must not let writes through (fail closed).
 */
export const shopFunctionsRatePolicies = definePolicies('shop-functions', {
  'shop-functions.submit.shop': {
    algorithm: 'slidingWindow',
    limit: 10,
    windowMs: 3_600_000,
    key: 'shop',
    failMode: 'closed',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof shopFunctionsRatePolicies.policies
  > {}
}
