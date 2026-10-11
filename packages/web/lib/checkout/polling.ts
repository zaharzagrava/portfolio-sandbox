/**
 * The polling fallback of W03 AS-39: used only while the live stream is down or silent. Pure schedule, no timers here.
 * Offsets are milliseconds after polling started: every 2 s for 30 s, then every 5 s for 5 minutes. The densest minute
 * holds 30 requests, which is the stated ceiling.
 */
export const FALLBACK_SILENCE_MS = 10_000;

const FAST_INTERVAL_MS = 2_000;
const FAST_WINDOW_MS = 30_000;
const SLOW_INTERVAL_MS = 5_000;
const SLOW_WINDOW_MS = 300_000;

export const POLL_OFFSETS_MS: readonly number[] = [
  ...Array.from({ length: FAST_WINDOW_MS / FAST_INTERVAL_MS }, (_, i) => (i + 1) * FAST_INTERVAL_MS),
  ...Array.from({ length: SLOW_WINDOW_MS / SLOW_INTERVAL_MS }, (_, i) => FAST_WINDOW_MS + (i + 1) * SLOW_INTERVAL_MS),
];

/** Milliseconds from `elapsedMs` (since polling started) to the next poll, or `null` when the schedule is over. */
export function nextPollDelay(elapsedMs: number): number | null {
  const next = POLL_OFFSETS_MS.find((at) => at > elapsedMs);
  return next === undefined ? null : next - elapsedMs;
}
