/**
 * When to try to re-attach to a reply after the connection dropped (W05 FR-052, AS-49). Offsets are measured from the moment
 * of the drop: 0, 1, 2, 4 and 8 s (all inside the server's 10 s grace period, S46 AS-26), then every 10 s until 2 minutes have
 * passed. After that the reply is given up as `lost` ("We couldn't reconnect to the reply.").
 */
export const RESUME_GIVE_UP_MS = 120_000;

const FIRST_OFFSETS_MS = [0, 1000, 2000, 4000, 8000] as const;
const EVERY_MS = 10_000;

/** The offset (ms after the drop) of attempt `attempt` (0-based), or `null` when the window is over. */
export function resumeOffset(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 0) return null;
  const offset = attempt < FIRST_OFFSETS_MS.length ? FIRST_OFFSETS_MS[attempt] : FIRST_OFFSETS_MS[FIRST_OFFSETS_MS.length - 1] + (attempt - FIRST_OFFSETS_MS.length + 1) * EVERY_MS;
  return offset < RESUME_GIVE_UP_MS ? offset : null;
}

/** How long to wait before attempt `attempt` when `elapsedMs` have passed since the drop; `null` when the window is over. */
export function resumeWait(attempt: number, elapsedMs: number): number | null {
  const offset = resumeOffset(attempt);
  return offset === null ? null : Math.max(0, offset - elapsedMs);
}
