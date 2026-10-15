import { createHash } from 'node:crypto';

/** The next scheduled pull after a completed run or an enqueue: 5 minutes plus a per-integration jitter (AS-20). */
export const SYNC_INTERVAL_MS = 5 * 60_000;
export const JITTER_WINDOW_MS = 60_000;

/** Deterministic jitter in `[0, 60 s)` from the integration id, so a fleet of integrations does not pull in lockstep. */
export function jitterMs(integrationId: string): number {
  return (
    createHash('sha256').update(integrationId).digest().readUInt32BE(0) %
    JITTER_WINDOW_MS
  );
}

export function nextDueAt(now: Date, integrationId: string): Date {
  return new Date(now.getTime() + SYNC_INTERVAL_MS + jitterMs(integrationId));
}
