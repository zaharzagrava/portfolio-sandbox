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
  // S22 (G-10, G-34, FR-011, FR-022, FR-038): joins are idempotent, so the limiter failing open is safe; a hold that
  // cannot be counted is refused (fail closed) because it takes quota and seats. Charged from the services.
  'launch.queue.join.user': {
    algorithm: 'slidingWindow',
    limit: 10,
    windowMs: 60_000,
    key: 'user',
    failMode: 'open',
  },
  'launch.hold.user': {
    algorithm: 'slidingWindow',
    limit: 30,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
  'launch.seatmap.ip': {
    algorithm: 'slidingWindow',
    limit: 600,
    windowMs: 60_000,
    key: 'ip',
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
