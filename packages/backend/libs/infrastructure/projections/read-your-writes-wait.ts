export type WaitOutcome = 'reached' | 'timeout' | 'unavailable';

/** The wait budget never exceeds this, whatever the caller asks for (S53 FR-047). */
export const MAX_WAIT_MS = 2_000;
const FIRST_POLL_MS = 10;
const MAX_POLL_MS = 100;

export interface WaitOptions {
  /** The version the read model has applied: a checkpoint, or the version a read replica reports (-1 when none). */
  probe: () => Promise<number>;
  minVersion: number;
  budgetMs: number;
  clock: { nowMs(): number };
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

/**
 * Waits for the applied version to reach `minVersion` (S53 FR-047, AS-81): probe, and if behind, sleep with jittered
 * polls that start at 10 ms and never exceed 100 ms, until the budget (clamped to 2,000 ms) is spent. `reached`
 * when the probe got there, `timeout` after exactly the budget, `unavailable` the moment the probe throws: the
 * caller falls back without waiting for a store that is down. Time and randomness are injected, so the logic is
 * testable in frozen time.
 */
export async function waitForVersion(
  options: WaitOptions,
): Promise<WaitOutcome> {
  const budget = Math.min(Math.max(options.budgetMs, 0), MAX_WAIT_MS);
  const deadline = options.clock.nowMs() + budget;
  for (let poll = 0; ; poll++) {
    try {
      if ((await options.probe()) >= options.minVersion) return 'reached';
    } catch {
      return 'unavailable';
    }
    const remaining = deadline - options.clock.nowMs();
    if (remaining <= 0) return 'timeout';
    // Exponential growth from 10 ms to the 100 ms ceiling, jittered downwards but never below the first interval.
    const ceiling = Math.min(MAX_POLL_MS, FIRST_POLL_MS * 2 ** poll);
    const interval = Math.max(
      FIRST_POLL_MS,
      Math.floor(ceiling * (0.5 + options.random() * 0.5)),
    );
    await options.sleep(Math.min(interval, remaining));
  }
}
