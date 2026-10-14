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

/**
 * Rate limit policies of analytics and experiments (S39 FR-008, FR-026, FR-030, FR-045). Ingestion and assignments are
 * counted per principal or address and fail open (a limiter outage must not drop analytics or blank a page's experiments);
 * admin writes and results reads are counted per admin and fail closed. Names are disjoint from `flagsRatePolicies`.
 */
export const analyticsRatePolicies = definePolicies('experimentation', {
  'analytics.ingest': {
    algorithm: 'slidingWindow',
    limit: 120,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'open',
  },
  'experiments.assignments': {
    algorithm: 'slidingWindow',
    limit: 120,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'open',
  },
  'experiments.admin.write': {
    algorithm: 'slidingWindow',
    limit: 30,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
  'experiments.results': {
    algorithm: 'slidingWindow',
    limit: 20,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  interface PolicyNameRegistry
    extends
      PolicyNamesOf<typeof flagsRatePolicies.policies>,
      PolicyNamesOf<typeof analyticsRatePolicies.policies> {}
}
