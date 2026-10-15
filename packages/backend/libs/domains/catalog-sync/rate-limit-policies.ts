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
  // S08 AS-55: per WooCommerce credential (5 req/s, burst 20); shared by every worker instance.
  'integrations.woocommerce': {
    algorithm: 'tokenBucket',
    limit: 20,
    windowMs: 4_000,
    key: 'apiKey',
    failMode: 'closed',
  },
  'catalog-sync.integration-write.shop': {
    algorithm: 'slidingWindow',
    limit: 30,
    windowMs: 60_000,
    key: 'shop',
    failMode: 'closed',
  },
  'catalog-sync.sync-now.integration': {
    algorithm: 'slidingWindow',
    limit: 1,
    windowMs: 60_000,
    key: 'custom',
    failMode: 'closed',
  },
  // S08 AS-70: a backfill re-reads the whole store, so it is limited to one per hour per integration.
  'catalog-sync.backfill-now.integration': {
    algorithm: 'slidingWindow',
    limit: 1,
    windowMs: 3_600_000,
    key: 'custom',
    failMode: 'closed',
  },
  'catalog-sync.reconcile-now.integration': {
    algorithm: 'slidingWindow',
    limit: 1,
    windowMs: 3_600_000,
    key: 'custom',
    failMode: 'closed',
  },
  'catalog-sync.webhook.integration': {
    algorithm: 'slidingWindow',
    limit: 1_200,
    windowMs: 60_000,
    key: 'custom',
    failMode: 'open',
  },
  'catalog-sync.webhook.ip': {
    algorithm: 'slidingWindow',
    limit: 600,
    windowMs: 60_000,
    key: 'ip',
    failMode: 'open',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof catalogSyncRatePolicies.policies
  > {}
}
