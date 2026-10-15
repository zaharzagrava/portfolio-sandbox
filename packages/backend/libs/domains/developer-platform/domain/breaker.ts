import { assertNever } from './errors';

/**
 * Per-endpoint circuit breaker as a pure state machine (S43 FR-034, AS-47, AS-48). The state is disposable and lives in
 * a fast store; the machine never reads a clock (the caller passes `now` in epoch milliseconds) and never touches a
 * store. After `failureThreshold` consecutive failures the breaker opens for `baseOpenMs`, doubling with every further
 * failure up to `maxOpenMs`; when the time has passed exactly one probe is admitted; a success closes it.
 */
export interface BreakerConfig {
  failureThreshold: number;
  baseOpenMs: number;
  maxOpenMs: number;
  /** How long a delivery held back by a probe in flight waits before looking again. */
  probeWaitMs: number;
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  failureThreshold: 5,
  baseOpenMs: 60_000,
  maxOpenMs: 30 * 60_000,
  probeWaitMs: 10_000,
};

export interface BreakerState {
  consecutiveFailures: number;
  /** Epoch ms until which the breaker stays open; null when it never opened. */
  openUntil: number | null;
  probeInFlight: boolean;
}

export const CLOSED_BREAKER: BreakerState = {
  consecutiveFailures: 0,
  openUntil: null,
  probeInFlight: false,
};

export type BreakerStatus = 'closed' | 'open' | 'half-open';

export type BreakerDecision =
  | { action: 'send' }
  /** Send nothing; reschedule the delivery for `until` (epoch ms) without consuming an attempt. */
  | { action: 'skip'; until: number }
  /** The caller must win the probe lease (atomically) before sending; if it loses, treat the answer as `skip`. */
  | { action: 'probe' };

/** Open duration after `failures` consecutive failures: 0 below the threshold, then base, 2x, 4x ... capped. */
export function openDurationMs(
  failures: number,
  config: Pick<
    BreakerConfig,
    'failureThreshold' | 'baseOpenMs' | 'maxOpenMs'
  > = DEFAULT_BREAKER_CONFIG,
): number {
  if (failures < config.failureThreshold) return 0;
  const doublings = failures - config.failureThreshold;
  // 2 ** 52 is far above any cap; avoids Infinity for absurd counters
  return Math.min(
    config.maxOpenMs,
    config.baseOpenMs * 2 ** Math.min(doublings, 52),
  );
}

export function breakerStatus(
  state: BreakerState,
  now: number,
  config: Pick<BreakerConfig, 'failureThreshold'> = DEFAULT_BREAKER_CONFIG,
): BreakerStatus {
  if (state.consecutiveFailures < config.failureThreshold) return 'closed';
  if (state.openUntil !== null && now < state.openUntil) return 'open';
  return 'half-open';
}

export function decideBreaker(
  state: BreakerState,
  now: number,
  config: BreakerConfig = DEFAULT_BREAKER_CONFIG,
): BreakerDecision {
  const status = breakerStatus(state, now, config);
  switch (status) {
    case 'closed':
      return { action: 'send' };
    case 'open':
      return { action: 'skip', until: state.openUntil as number };
    case 'half-open':
      return state.probeInFlight
        ? { action: 'skip', until: now + config.probeWaitMs }
        : { action: 'probe' };
    default:
      return assertNever(status);
  }
}

/** A failed attempt (also a failed probe): one more consecutive failure; at the threshold and beyond it opens. */
export function onBreakerFailure(
  state: BreakerState,
  now: number,
  config: BreakerConfig = DEFAULT_BREAKER_CONFIG,
): BreakerState {
  const consecutiveFailures = state.consecutiveFailures + 1;
  const duration = openDurationMs(consecutiveFailures, config);
  return {
    consecutiveFailures,
    openUntil: duration > 0 ? now + duration : null,
    probeInFlight: false,
  };
}

/** Any success closes the breaker and resets the count. */
export function onBreakerSuccess(_state: BreakerState): BreakerState {
  return { ...CLOSED_BREAKER };
}

/** Exhaustive text for the status (used by the dashboard's `breaker` field: open or closed, half-open reads as open). */
export function describeBreakerStatus(status: BreakerStatus): string {
  switch (status) {
    case 'closed':
      return 'closed';
    case 'open':
    case 'half-open':
      return 'open';
    default:
      return assertNever(status);
  }
}
