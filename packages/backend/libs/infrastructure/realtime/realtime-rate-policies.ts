import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/**
 * Rate policy declared by the hub into S50 (S51 FR-035): 60 new stream connections per minute per user (or address
 * when anonymous). Fails open: a limiter outage must not cut live updates.
 */
export const realtimeRatePolicies = definePolicies('realtime', {
  'realtime.connect': {
    algorithm: 'slidingWindow',
    limit: 60,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'open',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof realtimeRatePolicies.policies
  > {}
}
