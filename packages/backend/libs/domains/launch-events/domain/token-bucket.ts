/**
 * Admission token bucket (S22 FR-004): capacity is one second of the rate, refill is continuous, so a worker that was
 * down for five seconds admits at most `rate` on its next tick (no catch-up burst). Pure: time comes in as a number.
 */
export interface BucketState {
  tokens: number;
  atMs: number;
}

export const fullBucket = (rate: number, nowMs: number): BucketState => ({
  tokens: rate,
  atMs: nowMs,
});

/** Refills to `nowMs` and takes up to `want` whole tokens. A clock that moves backwards adds nothing. */
export const takeFromBucket = (
  state: BucketState,
  nowMs: number,
  rate: number,
  want: number,
): { state: BucketState; granted: number } => {
  const elapsed = Math.max(0, nowMs - state.atMs);
  const refilled = Math.min(rate, state.tokens + (elapsed * rate) / 1000);
  // The epsilon absorbs float drift of fractional refills (0.3 + 0.3 + 0.3 must reach 0.9, not 0.8999…).
  const granted = Math.max(0, Math.min(Math.floor(refilled + 1e-9), want));
  return {
    granted,
    state: { tokens: refilled - granted, atMs: Math.max(nowMs, state.atMs) },
  };
};
