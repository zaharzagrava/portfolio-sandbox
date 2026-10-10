export type RateLimitAlgorithm =
  'tokenBucket' | 'slidingWindow' | 'concurrency';
export type RateLimitKeySource =
  'ip' | 'user' | 'userOrIp' | 'apiKey' | 'shop' | 'body.email' | 'custom';

export interface RateLimitPolicy {
  algorithm: RateLimitAlgorithm;
  /** tokenBucket: capacity (burst); slidingWindow: requests per window; concurrency: max in flight. */
  limit: number;
  /** tokenBucket: refill period for `limit` tokens; slidingWindow: window size; concurrency: lease length. */
  windowMs: number;
  key: RateLimitKeySource;
  /** What to do when the store is unavailable: `open` = serve with the in-process fallback, `closed` = refuse. No default. */
  failMode: 'open' | 'closed';
  /** tokenBucket only: fraction in (0, 0.5] of the budget an instance may take locally per store call. */
  localLeaseFraction?: number;
  /** Only failed attempts keep their slot (login). */
  count?: 'failures-only';
  /** With `count: 'failures-only'`: a 2xx clears the counter. */
  resetOnSuccess?: boolean;
  /** With `count: 'failures-only'`: statuses that keep the slot (default 401, 403). */
  failureStatuses?: readonly number[];
}

/**
 * Policy names known to the type system. Owners add theirs by module augmentation next to their `definePolicies` call:
 * `declare module '@app/infrastructure/rate-limit/rate-limit.types' { interface PolicyNameRegistry extends PolicyNamesOf<typeof table> {} }`
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- extended by each owner's module augmentation
export interface PolicyNameRegistry extends PolicyNamesOf<
  typeof DEFAULT_POLICIES
> {}

export type PolicyNamesOf<T> = { [K in keyof T]: true };

export type RateLimitPolicyName = keyof PolicyNameRegistry & string;

export interface RateLimitDecision {
  allowed: boolean;
  policy: string;
  limit: number;
  remaining: number;
  /** ms until the next request may succeed (0 when allowed); `null` when waiting never helps. */
  retryAfterMs: number | null;
  resetMs: number;
  /** Which path made the decision - exposed in metrics. */
  source: 'store' | 'local-lease' | 'fallback';
  reason?:
    'limit-exceeded' | 'store-unavailable' | 'cost-exceeds-limit' | 'paused';
}

export type AcquireResult =
  | {
      acquired: true;
      release: () => Promise<void>;
      decision: RateLimitDecision;
    }
  | { acquired: false; decision: RateLimitDecision };

/** The only two policies this lib declares (FR-050); every other policy belongs to its owning capability. */
export const DEFAULT_POLICIES = {
  'default.read': {
    algorithm: 'tokenBucket',
    limit: 300,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'open',
  },
  'default.write': {
    algorithm: 'tokenBucket',
    limit: 60,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'open',
  },
} as const satisfies Record<string, RateLimitPolicy>;
