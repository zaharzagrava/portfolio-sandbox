/** Circuit breaker of one function (AS-29). Pure transitions; the Redis store applies the same rules atomically. */
export const BREAKER_FAILURES = 5;
export const BREAKER_WINDOW_MS = 60_000;
export const BREAKER_OPEN_MS = 300_000;
export const BREAKER_TRIAL_MS = 5_000;

export interface Breaker {
  /** Failures counted in the current window (the window starts at the first failure). */
  count: number;
  windowStart: number | null;
  openUntil: number | null;
  /** While a trial call is running (HALF_OPEN) no other trial is admitted. */
  trialUntil: number | null;
  lastFailure: { reason: string; at: number } | null;
}

export const CLOSED_BREAKER: Breaker = {
  count: 0,
  windowStart: null,
  openUntil: null,
  trialUntil: null,
  lastFailure: null,
};

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface BreakerView {
  state: BreakerState;
  openUntil: number | null;
  lastFailure: { reason: string; at: number } | null;
}

export function breakerView(b: Breaker, now: number): BreakerView {
  const state: BreakerState =
    b.openUntil === null ? 'CLOSED' : now >= b.openUntil ? 'HALF_OPEN' : 'OPEN';
  return {
    state,
    openUntil: state === 'CLOSED' ? null : b.openUntil,
    lastFailure: b.lastFailure,
  };
}

export type Admission = 'ADMIT' | 'SKIP' | 'TRIAL';

export function admit(
  b: Breaker,
  now: number,
): { decision: Admission; next: Breaker } {
  const { state } = breakerView(b, now);
  if (state === 'CLOSED') return { decision: 'ADMIT', next: b };
  if (state === 'OPEN') return { decision: 'SKIP', next: b };
  if (b.trialUntil !== null && b.trialUntil > now)
    return { decision: 'SKIP', next: b };
  return {
    decision: 'TRIAL',
    next: { ...b, trialUntil: now + BREAKER_TRIAL_MS },
  };
}

export function recordFailure(
  b: Breaker,
  now: number,
  reason: string,
): Breaker {
  const lastFailure = { reason, at: now };
  const { state } = breakerView(b, now);
  if (state === 'OPEN') return { ...b, lastFailure };
  if (state === 'HALF_OPEN')
    return {
      count: 0,
      windowStart: null,
      openUntil: now + BREAKER_OPEN_MS,
      trialUntil: null,
      lastFailure,
    };
  const fresh =
    b.windowStart === null || now - b.windowStart >= BREAKER_WINDOW_MS;
  const count = fresh ? 1 : b.count + 1;
  const windowStart = fresh ? now : b.windowStart;
  if (count >= BREAKER_FAILURES)
    return {
      count: 0,
      windowStart: null,
      openUntil: now + BREAKER_OPEN_MS,
      trialUntil: null,
      lastFailure,
    };
  return { ...b, count, windowStart, lastFailure };
}

export function recordSuccess(b: Breaker, now: number): Breaker {
  if (breakerView(b, now).state === 'HALF_OPEN')
    return { ...CLOSED_BREAKER, lastFailure: b.lastFailure };
  return b;
}
