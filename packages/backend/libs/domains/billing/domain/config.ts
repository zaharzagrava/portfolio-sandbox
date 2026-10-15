/**
 * Fixed limits of billing (S17 spec FR-022, FR-027, FR-031, FR-033, FR-026, FR-060). They are product rules, not
 * settings: the dunning offsets and the 30-day `UNPAID` expiry are deliberately not configurable.
 */
export const BILLING_LIMITS = {
  /** Subscriptions looked at per billing run. */
  runBatch: 500,
  /** The provider create call (S17 FR-031). */
  providerTimeoutMs: 8_000,
  /** The provider lookup by our reference. */
  lookupTimeoutMs: 8_000,
  /** The usage lines a renewal asks for (S18). */
  usageTimeoutMs: 5_000,
  /** A claimed attempt with no result after this long is treated as unknown (above the call timeout). */
  claimTimeoutMs: 60_000,
  /** First resolution of an unknown attempt. */
  firstResolutionDelayMs: 30_000,
  /** Longest an attempt may stay unknown with nothing found at the provider. */
  unknownLimitMs: 60 * 60_000,
  /** Cap of the resolution backoff. */
  resolutionBackoffCapMs: 15 * 60_000,
  /** How long a subscription may stay `UNPAID` before it is cancelled. */
  unpaidExpiryMs: 30 * 86_400_000,
  /** A due subscription older than this counts as overdue in the gauge. */
  overdueAfterMs: 30 * 60_000,
} as const;
