import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/**
 * Rate limit policies owned by `asset-library` (S50, S31 FR-046). Checked in code by the services (S50: `@RateLimit` is
 * metadata only), so they hold in every app. Upload and grant fail closed (they write or issue credentials); the
 * anonymous address limit fails open, so a limiter outage never blocks a legitimate download.
 */
export const assetRatePolicies = definePolicies('asset-library', {
  'assets.upload.shop': {
    algorithm: 'slidingWindow',
    limit: 120,
    windowMs: 60_000,
    key: 'shop',
    failMode: 'closed',
  },
  'assets.redeem.ip': {
    algorithm: 'slidingWindow',
    limit: 60,
    windowMs: 60_000,
    key: 'ip',
    failMode: 'open',
  },
  'assets.grant.user': {
    algorithm: 'slidingWindow',
    limit: 30,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof assetRatePolicies.policies
  > {}
}
