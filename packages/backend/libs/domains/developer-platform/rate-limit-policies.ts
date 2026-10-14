import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/**
 * Rate limit policies owned by `developer-platform` (S50 FR-050, S42 contracts/http.md section C): registered by
 * `PublicApiModule` through `RateLimitModule.forFeature`.
 *  - `public-api.default`: per key, 6,000 units a minute; a request costs 1, a batch its operation count, a bulk stock
 *    call `ceil(items / 100)`. Fails open: a limiter outage must not take a seller's integration down (AS-56).
 *  - `public-api.auth-failure.ip`: charged only after a failed authentication, per client address. Fails closed: when the
 *    counter cannot be read, guessing keys must not become free.
 */
export const developerPlatformRatePolicies = definePolicies(
  'developer-platform',
  {
    'public-api.default': {
      algorithm: 'tokenBucket',
      limit: 6000,
      windowMs: 60_000,
      key: 'apiKey',
      failMode: 'open',
      localLeaseFraction: 0.05,
    },
    'public-api.auth-failure.ip': {
      algorithm: 'slidingWindow',
      limit: 30,
      windowMs: 60_000,
      key: 'ip',
      failMode: 'closed',
    },
    // S44 (specs/domains/S44-storefront-widget/contracts/rate-limits-config.md). The public read stays up when the
    // limiter store fails; token minting and management do not.
    'widget.config.ip': {
      algorithm: 'slidingWindow',
      limit: 600,
      windowMs: 60_000,
      key: 'ip',
      failMode: 'open',
    },
    'widget.identify.ip': {
      algorithm: 'slidingWindow',
      limit: 30,
      windowMs: 60_000,
      key: 'ip',
      failMode: 'closed',
    },
    'widget.identify.site': {
      algorithm: 'slidingWindow',
      limit: 1200,
      windowMs: 60_000,
      key: 'custom',
      failMode: 'closed',
    },
    'widget.manage.shop': {
      algorithm: 'slidingWindow',
      limit: 60,
      windowMs: 60_000,
      key: 'shop',
      failMode: 'closed',
    },
  } as const,
);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof developerPlatformRatePolicies.policies
  > {}
}
