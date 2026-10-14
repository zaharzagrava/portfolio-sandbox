import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/**
 * Rate limit policies owned by `experimentation` (S38 FR-043, FR-061). Admin writes are counted per admin (reads are not
 * limited); the client endpoint is counted per principal, or per IP address for visitors, and fails open: a limiter
 * outage must not blank every page's flags.
 */
export const flagsRatePolicies = definePolicies('experimentation', {
  'flags.admin.write': {
    algorithm: 'slidingWindow',
    limit: 30,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
  'flags.client.read': {
    algorithm: 'slidingWindow',
    limit: 120,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'open',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof flagsRatePolicies.policies
  > {}
}
