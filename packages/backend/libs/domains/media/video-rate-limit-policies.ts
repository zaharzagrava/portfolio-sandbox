import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/**
 * S30 budgets (S30 R-04, R-18). Starting an upload is a cost attack surface on storage (20 an hour per shop) and every
 * other seller write is capped per shop; both fail closed. Playback and the product list are cheap, cacheable reads, so
 * they fail open (a limiter outage must not take video down).
 */
export const videoRatePolicies = definePolicies('video', {
  'video.start.shop': {
    algorithm: 'tokenBucket',
    limit: 20,
    windowMs: 3_600_000,
    key: 'shop',
    failMode: 'closed',
  },
  'video.write.shop': {
    algorithm: 'tokenBucket',
    limit: 120,
    windowMs: 60_000,
    key: 'shop',
    failMode: 'closed',
  },
  'video.playback.ip': {
    algorithm: 'tokenBucket',
    limit: 600,
    windowMs: 60_000,
    key: 'ip',
    failMode: 'open',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof videoRatePolicies.policies
  > {}
}
