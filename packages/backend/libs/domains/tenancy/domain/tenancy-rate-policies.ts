import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

const HOUR = 3_600_000;
const MINUTE = 60_000;

/**
 * Rate limit policies owned by `tenancy` (S50), all fail-closed; per-shop and per-user keys give the bulkhead
 * (one noisy shop or user cannot starve the others). `tenancy.invite-accept.user` counts failures only (brute force
 * against invite tokens): a 404 keeps its slot.
 */
export const tenancyRatePolicies = definePolicies('tenancy', {
  'tenancy.shop-create.user': {
    algorithm: 'slidingWindow',
    limit: 5,
    windowMs: HOUR,
    key: 'user',
    failMode: 'closed',
  },
  'tenancy.invite.shop': {
    algorithm: 'slidingWindow',
    limit: 20,
    windowMs: HOUR,
    key: 'shop',
    failMode: 'closed',
  },
  'tenancy.invite-accept.user': {
    algorithm: 'slidingWindow',
    limit: 10,
    windowMs: 15 * MINUTE,
    key: 'user',
    failMode: 'closed',
    count: 'failures-only',
    failureStatuses: [404],
  },
  'tenancy.invite-accept.ip': {
    algorithm: 'slidingWindow',
    limit: 30,
    windowMs: MINUTE,
    key: 'ip',
    failMode: 'closed',
  },
  'tenancy.sso-lookup.ip': {
    algorithm: 'slidingWindow',
    limit: 30,
    windowMs: MINUTE,
    key: 'ip',
    failMode: 'closed',
  },
  'tenancy.shop-write.shop': {
    algorithm: 'slidingWindow',
    limit: 120,
    windowMs: MINUTE,
    key: 'shop',
    failMode: 'closed',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof tenancyRatePolicies.policies
  > {}
}
