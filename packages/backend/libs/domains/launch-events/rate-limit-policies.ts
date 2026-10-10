import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/** Rate limit policies owned by `launch-events` (S50 FR-050): registered by `LiveModule`. */
export const launchEventsRatePolicies = definePolicies('launch-events', {
  // SD-15: slow-mode-ish chat; reactions arrive pre-batched by the client (~1 request/s). No local lease.
  'live.comment': {
    algorithm: 'tokenBucket',
    limit: 3,
    windowMs: 10_000,
    key: 'user',
    failMode: 'open',
  },
  'live.reaction': {
    algorithm: 'tokenBucket',
    limit: 5,
    windowMs: 1_000,
    key: 'user',
    failMode: 'open',
    localLeaseFraction: 0.2,
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof launchEventsRatePolicies.policies
  > {}
}
