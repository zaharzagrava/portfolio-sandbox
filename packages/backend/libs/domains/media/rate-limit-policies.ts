import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/**
 * S29 own budgets (R-10): uploads no longer borrow `discussion.write` (S50 G-35). Presign is a cost attack surface on
 * storage, so the upload and gallery policies fail closed; photo reads are cheap and cacheable, so they fail open.
 * `complete` and `DELETE` carry none: they act only on rows the caller owns, are idempotent and are bounded by the
 * 50-slot pending quota.
 */
export const mediaRatePolicies = definePolicies('media', {
  'media.upload.user': {
    algorithm: 'tokenBucket',
    limit: 30,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
  'media.upload.shop': {
    algorithm: 'tokenBucket',
    limit: 120,
    windowMs: 60_000,
    key: 'shop',
    failMode: 'closed',
  },
  'media.gallery.shop': {
    algorithm: 'tokenBucket',
    limit: 60,
    windowMs: 60_000,
    key: 'shop',
    failMode: 'closed',
  },
  'media.read.ip': {
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
    typeof mediaRatePolicies.policies
  > {}
}
