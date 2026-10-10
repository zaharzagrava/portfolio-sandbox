import { definePolicies } from '../policy';
import type { PolicyNamesOf } from '../rate-limit.types';

/** Policies of the probe routes (test code only), declared by the test "owner" like any capability would. */
export const httpPolicies = definePolicies('rate-limit-http-test', {
  // US6: "limit 5, window 15 min"
  'http.p5': {
    algorithm: 'slidingWindow',
    limit: 5,
    windowMs: 900_000,
    key: 'userOrIp',
    failMode: 'closed',
  },
  'http.a20': {
    algorithm: 'slidingWindow',
    limit: 20,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'closed',
  },
  'http.b5': {
    algorithm: 'slidingWindow',
    limit: 5,
    windowMs: 900_000,
    key: 'userOrIp',
    failMode: 'closed',
  },
  // refund of earlier units: a = bucket, b = window (limit 2)
  'http.a5': {
    algorithm: 'tokenBucket',
    limit: 5,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'closed',
  },
  'http.a5-window': {
    algorithm: 'slidingWindow',
    limit: 5,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'closed',
  },
  'http.a5-conc': {
    algorithm: 'concurrency',
    limit: 5,
    windowMs: 30_000,
    key: 'userOrIp',
    failMode: 'closed',
  },
  'http.b2': {
    algorithm: 'slidingWindow',
    limit: 2,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'closed',
  },
  // cost
  'http.cost': {
    algorithm: 'tokenBucket',
    limit: 10,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'closed',
  },
  // protected route and tenants
  'http.user': {
    algorithm: 'tokenBucket',
    limit: 5,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
  'http.key': {
    algorithm: 'tokenBucket',
    limit: 5,
    windowMs: 60_000,
    key: 'apiKey',
    failMode: 'closed',
  },
  'http.shop': {
    algorithm: 'tokenBucket',
    limit: 5,
    windowMs: 60_000,
    key: 'shop',
    failMode: 'closed',
  },
  'http.ip20': {
    algorithm: 'slidingWindow',
    limit: 20,
    windowMs: 60_000,
    key: 'ip',
    failMode: 'closed',
  },
  'http.custom': {
    algorithm: 'tokenBucket',
    limit: 5,
    windowMs: 60_000,
    key: 'custom',
    failMode: 'closed',
  },
  'http.custom-open': {
    algorithm: 'tokenBucket',
    limit: 5,
    windowMs: 60_000,
    key: 'custom',
    failMode: 'open',
  },
  // idempotent route limited to 3
  'http.three': {
    algorithm: 'slidingWindow',
    limit: 3,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'closed',
  },
  // US8: 5 failed attempts per account per 15 minutes
  'http.login': {
    algorithm: 'slidingWindow',
    limit: 5,
    windowMs: 900_000,
    key: 'body.email',
    failMode: 'closed',
    count: 'failures-only',
    resetOnSuccess: true,
  },
  'http.login-bucket': {
    algorithm: 'tokenBucket',
    limit: 5,
    windowMs: 900_000,
    key: 'body.email',
    failMode: 'closed',
    count: 'failures-only',
    resetOnSuccess: true,
  },
  // US3: concurrency on a slow route
  'http.slow': {
    algorithm: 'concurrency',
    limit: 1,
    windowMs: 30_000,
    key: 'userOrIp',
    failMode: 'closed',
  },
  'http.slow-open': {
    algorithm: 'concurrency',
    limit: 2,
    windowMs: 30_000,
    key: 'userOrIp',
    failMode: 'open',
  },
  // fail modes over HTTP
  'http.closed': {
    algorithm: 'tokenBucket',
    limit: 5,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'closed',
  },
  'http.open': {
    algorithm: 'tokenBucket',
    limit: 60,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'open',
  },
  // paused bucket over HTTP
  'http.pausable': {
    algorithm: 'tokenBucket',
    limit: 5,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'closed',
  },
} as const);

declare module '../rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof httpPolicies.policies
  > {}
}
