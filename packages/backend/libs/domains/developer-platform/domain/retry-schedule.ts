/**
 * Retry schedule of a failed delivery (S43 FR-032, AS-41). Pure: the random value is injected, the numbers are
 * configuration (`webhook-settings.ts`). Attempts 1 to `laneAttempts` run in the endpoint's ordered lane 30 s apart,
 * then the delivery leaves the lane and is retried after each delay of `delaysMs`, each with +-`jitter`; after the last
 * delay's attempt it is exhausted (3 + 8 = 11 attempts).
 */
export interface RetryScheduleConfig {
  laneAttempts: number;
  laneDelayMs: number;
  delaysMs: readonly number[];
  jitter: number;
  maxDelayMs: number;
}

const MIN = 60_000;

export const DEFAULT_RETRY_SCHEDULE: RetryScheduleConfig = {
  laneAttempts: 3,
  laneDelayMs: 30_000,
  delaysMs: [5, 30, 120, 300, 600, 1440, 1440, 1440].map((m) => m * MIN),
  jitter: 0.2,
  maxDelayMs: 24 * 60 * MIN,
};

export const MAX_ATTEMPTS =
  DEFAULT_RETRY_SCHEDULE.laneAttempts + DEFAULT_RETRY_SCHEDULE.delaysMs.length;

export type RetryDecision =
  | { kind: 'retry'; lane: 'ordered' | 'delayed'; delayMs: number }
  | { kind: 'exhausted' };

export interface RetryInput {
  /** The attempt that just failed, starting at 1. */
  attempt: number;
  /** Uniform in [0, 1], injected (never `Math.random` in here). */
  random: number;
  /** Seconds from a `Retry-After` header, when the receiver sent a usable one. */
  retryAfterSec?: number;
}

export function nextRetry(
  input: RetryInput,
  config: RetryScheduleConfig = DEFAULT_RETRY_SCHEDULE,
): RetryDecision {
  const { attempt } = input;
  if (!Number.isInteger(attempt) || attempt < 1)
    throw new Error(`attempt must be an integer >= 1, got ${attempt}`);
  const retryAfterMs =
    typeof input.retryAfterSec === 'number' &&
    Number.isFinite(input.retryAfterSec) &&
    input.retryAfterSec > 0
      ? input.retryAfterSec * 1000
      : 0;
  const random = Math.min(
    1,
    Math.max(0, Number.isFinite(input.random) ? input.random : 0.5),
  );

  const merge = (delayMs: number): number =>
    Math.min(Math.max(delayMs, retryAfterMs), config.maxDelayMs);

  if (attempt < config.laneAttempts) {
    const delayMs = merge(config.laneDelayMs);
    // A receiver that asks for more than the lane delay must not hold the lane: the delivery leaves it.
    return {
      kind: 'retry',
      lane: delayMs > config.laneDelayMs ? 'delayed' : 'ordered',
      delayMs,
    };
  }
  const index = attempt - config.laneAttempts;
  if (index >= config.delaysMs.length) return { kind: 'exhausted' };
  const base = config.delaysMs[index];
  const jittered = Math.round(
    base * (1 - config.jitter + 2 * config.jitter * random),
  );
  return { kind: 'retry', lane: 'delayed', delayMs: merge(jittered) };
}
