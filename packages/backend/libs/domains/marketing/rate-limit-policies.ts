import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/**
 * Rate limit policies owned by `marketing`: share links (S37 G8, registered by `ShareLinksModule`) and sponsored listings
 * (S36 G6, S50 follow-up). Campaign writes spend the shop's money, so they fail closed and are counted per shop; reads
 * and the public slots endpoint fail open (a limiter outage must not take the storefront down). The click endpoint has no
 * policy by design: a limiter must never cost the shopper the redirect (FR-020).
 */
export const marketingRatePolicies = definePolicies('marketing', {
  'share-link.create': {
    algorithm: 'tokenBucket',
    limit: 20,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
  'marketing.ads-write.shop': {
    algorithm: 'slidingWindow',
    limit: 60,
    windowMs: 60_000,
    key: 'shop',
    failMode: 'closed',
  },
  'marketing.ads-read.shop': {
    algorithm: 'slidingWindow',
    limit: 300,
    windowMs: 60_000,
    key: 'shop',
    failMode: 'open',
  },
  'marketing.ads-serve.ip': {
    algorithm: 'slidingWindow',
    limit: 120,
    windowMs: 60_000,
    key: 'ip',
    failMode: 'open',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof marketingRatePolicies.policies
  > {}
}
