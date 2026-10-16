import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/** Rate limit policies owned by `catalog-sync` (S50 FR-050): registered by the import and integrations modules. */
export const catalogSyncRatePolicies = definePolicies('catalog-sync', {
  // S07 FR-039: ten import starts per hour per shop. Called in code by the start service (S50: `@RateLimit` is
  // metadata only), so it holds in every app. Fairness between shops is the run lease, not a limiter policy.
  'catalog-sync.import-start.shop': {
    algorithm: 'slidingWindow',
    limit: 10,
    windowMs: 3_600_000,
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
  // S09 FR-034: per device and shop (`shopId:deviceId` composed by the route's subject resolver).
  'catalog-sync.sync-push.device': {
    algorithm: 'slidingWindow',
    limit: 30,
    windowMs: 60_000,
    key: 'custom',
    failMode: 'closed',
  },
  'catalog-sync.sync-pull.device': {
    algorithm: 'slidingWindow',
    limit: 120,
    windowMs: 60_000,
    key: 'custom',
    failMode: 'closed',
  },
  'catalog-sync.conflict-write.shop': {
    algorithm: 'slidingWindow',
    limit: 60,
    windowMs: 60_000,
    key: 'shop',
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
