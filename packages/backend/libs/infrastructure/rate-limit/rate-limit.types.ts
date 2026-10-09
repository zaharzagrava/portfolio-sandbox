export type RateLimitAlgorithm =
  'tokenBucket' | 'slidingWindow' | 'concurrency';
export type RateLimitKeySource =
  'ip' | 'user' | 'apiKey' | 'shop' | 'userOrIp' | 'body.email';

export interface RateLimitPolicy {
  algorithm: RateLimitAlgorithm;
  /** tokenBucket: capacity (burst); slidingWindow: requests per window; concurrency: max in flight. */
  limit: number;
  /** tokenBucket: refill period for `limit` tokens; slidingWindow: window size; concurrency: lease length. */
  windowMs: number;
  key: RateLimitKeySource;
  /**
   * What to do when Redis is unavailable (lesson 10/02 Ex3): `open` = allow
   * (with a per-instance in-memory limiter as a safety net) for availability;
   * `closed` = reject for expensive/abuse-prone endpoints.
   */
  failMode: 'open' | 'closed';
  /** tokenBucket only: fraction of the budget an instance may take locally per Redis call (0 = always ask Redis). */
  localLeaseFraction?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** ms until the next request may succeed (0 when allowed). */
  retryAfterMs: number;
  resetMs: number;
  /** Which path made the decision - exposed in metrics. */
  source: 'redis' | 'local-lease' | 'fallback' | 'fail-closed';
}

/**
 * Named policies (satisfies → literal keys stay type-checked for @RateLimit).
 * Layering (lesson 10/02 Ex3): edge per IP (edge-be) → these per user/key →
 * business quotas per shop/plan (SD-24 entitlements).
 */
export const RATE_LIMIT_POLICIES = {
  'auth.login.ip': {
    algorithm: 'slidingWindow',
    limit: 20,
    windowMs: 60_000,
    key: 'ip',
    failMode: 'closed',
  },
  'auth.login.account': {
    algorithm: 'slidingWindow',
    limit: 5,
    windowMs: 15 * 60_000,
    key: 'body.email',
    failMode: 'closed',
  },
  'search.query': {
    algorithm: 'tokenBucket',
    limit: 60,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'open',
    localLeaseFraction: 0.1,
  },
  'checkout.create': {
    algorithm: 'tokenBucket',
    limit: 10,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
  'public-api.default': {
    algorithm: 'tokenBucket',
    limit: 6000,
    windowMs: 60_000,
    key: 'apiKey',
    failMode: 'open',
    localLeaseFraction: 0.05,
  },
  // SD-27 fairness: one running import per shop, so a 5 GB catalog can't starve every other shop's import.
  'imports.concurrent': {
    algorithm: 'concurrency',
    limit: 1,
    windowMs: 30 * 60_000,
    key: 'shop',
    failMode: 'closed',
  },
  // SD-36: per provider CREDENTIAL (Shopify REST: 2 req/s leaky bucket, burst 40) - shared by every worker instance.
  'integrations.shopify': {
    algorithm: 'tokenBucket',
    limit: 40,
    windowMs: 20_000,
    key: 'apiKey',
    failMode: 'closed',
  },
  'exports.concurrent': {
    algorithm: 'concurrency',
    limit: 2,
    windowMs: 10 * 60_000,
    key: 'shop',
    failMode: 'closed',
  },
  'auction.bid': {
    algorithm: 'tokenBucket',
    limit: 10,
    windowMs: 10_000,
    key: 'user',
    failMode: 'closed',
  },
  'discussion.write': {
    algorithm: 'tokenBucket',
    limit: 10,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
  'discussion.vote': {
    algorithm: 'tokenBucket',
    limit: 60,
    windowMs: 60_000,
    key: 'user',
    failMode: 'open',
    localLeaseFraction: 0.1,
  },
  // SD-17 provider send rates (subject = provider, fleet-wide): SES default 14/s, Twilio ~10/s per number, FCM generous.
  'notify.email': {
    algorithm: 'tokenBucket',
    limit: 14,
    windowMs: 1_000,
    key: 'apiKey',
    failMode: 'open',
    localLeaseFraction: 0.2,
  },
  'notify.sms': {
    algorithm: 'tokenBucket',
    limit: 10,
    windowMs: 1_000,
    key: 'apiKey',
    failMode: 'open',
  },
  'notify.push': {
    algorithm: 'tokenBucket',
    limit: 500,
    windowMs: 1_000,
    key: 'apiKey',
    failMode: 'open',
    localLeaseFraction: 0.1,
  },
  // SD-15: slow-mode-ish chat; reactions arrive pre-batched by the client (~1 request/s).
  'live.comment': {
    algorithm: 'tokenBucket',
    limit: 3,
    windowMs: 10_000,
    key: 'user',
    failMode: 'open',
    localLeaseFraction: 0,
  },
  'live.reaction': {
    algorithm: 'tokenBucket',
    limit: 5,
    windowMs: 1_000,
    key: 'user',
    failMode: 'open',
    localLeaseFraction: 0.2,
  },
  'llm.messages': {
    algorithm: 'tokenBucket',
    limit: 20,
    windowMs: 60_000,
    key: 'user',
    failMode: 'closed',
  },
  // SD-43: questions to the docs (anonymous buyers included) - each one is an embedding + a model call.
  'rag.ask': {
    algorithm: 'tokenBucket',
    limit: 10,
    windowMs: 60_000,
    key: 'userOrIp',
    failMode: 'closed',
  },
  // SD-42: the provider's tokens-per-minute limit, shared by the whole fleet (subject = model). Taken with cost = estimated tokens.
  // Fail open: Redis down must not take the assistant down; the provider's own 429 is the backstop.
  'llm.provider.tpm': {
    algorithm: 'tokenBucket',
    limit: 2_000_000,
    windowMs: 60_000,
    key: 'apiKey',
    failMode: 'open',
  },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitPolicyName = keyof typeof RATE_LIMIT_POLICIES;
