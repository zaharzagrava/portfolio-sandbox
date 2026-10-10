import { definePolicies } from '../policy';
import type { PolicyNamesOf } from '../rate-limit.types';

/**
 * Policies declared by the lib's own specs (test code only). They are an owner like any other: registered through
 * `forFeature`, and added to the name union by augmentation so `check('probe.x', ...)` type-checks in the specs.
 */
export const probePolicies = definePolicies('rate-limit-test', {
  // token bucket: burst 10, refill 10 per minute (one token per 6 s)
  'probe.burst': {
    algorithm: 'tokenBucket',
    limit: 10,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
  'probe.burst-b': {
    algorithm: 'tokenBucket',
    limit: 10,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
  'probe.resize': {
    algorithm: 'tokenBucket',
    limit: 100,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
  // sliding window
  'probe.window5': {
    algorithm: 'slidingWindow',
    limit: 5,
    windowMs: 15 * 60_000,
    key: 'body.email',
    failMode: 'closed',
  },
  'probe.window100': {
    algorithm: 'slidingWindow',
    limit: 100,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
  'probe.window10': {
    algorithm: 'slidingWindow',
    limit: 10,
    windowMs: 10_000,
    key: 'user',
    failMode: 'closed',
  },
  // concurrency
  'probe.conc2': {
    algorithm: 'concurrency',
    limit: 2,
    windowMs: 30_000,
    key: 'user',
    failMode: 'closed',
  },
  'probe.conc2-open': {
    algorithm: 'concurrency',
    limit: 2,
    windowMs: 30_000,
    key: 'user',
    failMode: 'open',
  },
  // local lease: 60 per minute, slices of 6
  'probe.hot': {
    algorithm: 'tokenBucket',
    limit: 60,
    windowMs: 60_000,
    key: 'user',
    failMode: 'open',
    localLeaseFraction: 0.1,
  },
  'probe.hot-closed': {
    algorithm: 'tokenBucket',
    limit: 60,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
    localLeaseFraction: 0.1,
  },
  'probe.no-lease': {
    algorithm: 'tokenBucket',
    limit: 60,
    windowMs: 60_000,
    key: 'user',
    failMode: 'open',
  },
  // fail modes
  'probe.open60': {
    algorithm: 'tokenBucket',
    limit: 60,
    windowMs: 60_000,
    key: 'user',
    failMode: 'open',
  },
  'probe.closed': {
    algorithm: 'tokenBucket',
    limit: 10,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
} as const);

declare module '../rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof probePolicies.policies
  > {}
}
