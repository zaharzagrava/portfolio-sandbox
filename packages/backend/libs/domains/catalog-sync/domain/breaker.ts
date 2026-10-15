/**
 * Per-integration circuit breaker as plain data (persisted on the Integration row) (AS-59, FR-052).
 * 5 consecutive failed calls (after retries) open it for 5 minutes; then exactly one probe is let through.
 */
export const BREAKER_FAILURES = 5;
export const BREAKER_OPEN_MS = 5 * 60_000;
/** While a probe is in flight, other callers stay blocked for this long (a probe that never reports back expires). */
export const BREAKER_PROBE_LEASE_MS = 30_000;

export interface BreakerState {
  failures: number;
  openUntil: Date | null;
  /** A probe has been handed out and has not reported yet. */
  halfOpen: boolean;
  /** The attention event was raised and the breaker has not closed since. */
  attentionRaised: boolean;
}

export type BreakerPhase = 'closed' | 'open' | 'half_open';
export type Acquire = 'allow' | 'blocked' | 'probe';

export const initialBreaker = (): BreakerState => ({
  failures: 0,
  openUntil: null,
  halfOpen: false,
  attentionRaised: false,
});

export function breakerPhase(state: BreakerState, now: Date): BreakerPhase {
  if (state.openUntil === null) return 'closed';
  if (state.halfOpen) return 'half_open';
  return now.getTime() < state.openUntil.getTime() ? 'open' : 'half_open';
}

/** Gate before a provider call. A `probe` decision returns the state that must be stored before calling. */
export function tryAcquire(
  state: BreakerState,
  now: Date,
): { decision: Acquire; state: BreakerState } {
  if (state.openUntil === null) return { decision: 'allow', state };
  if (now.getTime() < state.openUntil.getTime())
    return { decision: 'blocked', state };
  return {
    decision: 'probe',
    state: {
      ...state,
      halfOpen: true,
      openUntil: new Date(now.getTime() + BREAKER_PROBE_LEASE_MS),
    },
  };
}

export function recordSuccess(_state: BreakerState): BreakerState {
  return initialBreaker();
}

export function recordFailure(
  state: BreakerState,
  now: Date,
): { state: BreakerState; opened: boolean; raiseAttention: boolean } {
  const reopenAt = new Date(now.getTime() + BREAKER_OPEN_MS);
  if (state.halfOpen) {
    return {
      state: {
        ...state,
        failures: state.failures + 1,
        openUntil: reopenAt,
        halfOpen: false,
      },
      opened: true,
      raiseAttention: false,
    };
  }
  if (state.openUntil !== null) {
    // late failure of a call started before the breaker opened: no change
    return { state, opened: false, raiseAttention: false };
  }
  const failures = state.failures + 1;
  if (failures < BREAKER_FAILURES)
    return {
      state: { ...state, failures },
      opened: false,
      raiseAttention: false,
    };
  return {
    state: {
      failures,
      openUntil: reopenAt,
      halfOpen: false,
      attentionRaised: true,
    },
    opened: true,
    raiseAttention: !state.attentionRaised,
  };
}
