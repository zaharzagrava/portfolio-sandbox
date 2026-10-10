import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/** Rate limit policies owned by `catalog-sync` (S50 FR-050): registered by the import and integrations modules. */
export const catalogSyncRatePolicies = definePolicies('catalog-sync', {
  // SD-27 fairness: one running import per shop, so a 5 GB catalog can't starve every other shop's import.
  'imports.concurrent': {
    algorithm: 'concurrency',
    limit: 1,
    windowMs: 30 * 60_000,
    key: 'shop',
    failMode: 'closed',
  },
  // SD-36: per provider CREDENTIAL (Shopify REST: 2 req/s leaky bucket, burst 40) - shared by every worker instance.
  'integrations.shopify': {
    algorithm: 'tokenBucket',
    limit: 40,
    windowMs: 20_000,
    key: 'apiKey',
    failMode: 'closed',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof catalogSyncRatePolicies.policies
  > {}
}
