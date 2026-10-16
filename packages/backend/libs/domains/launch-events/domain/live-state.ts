import type { LiveStatus } from '@marketplace-sandbox/contracts';

export type { LiveStatus };

/** What asking for `to` does to a stream that is `from` (FR-001). */
export type LiveTransition = 'move' | 'noop' | 'illegal';

const TABLE: Record<LiveStatus, Record<LiveStatus, LiveTransition>> = {
  SCHEDULED: { SCHEDULED: 'noop', LIVE: 'move', ENDED: 'move' },
  LIVE: { SCHEDULED: 'illegal', LIVE: 'noop', ENDED: 'move' },
  ENDED: { SCHEDULED: 'illegal', LIVE: 'illegal', ENDED: 'noop' },
};

/** `SCHEDULED → LIVE → ENDED` and `SCHEDULED → ENDED` only; repeating a done move is a no-op, never an error. */
export const liveTransition = (
  from: LiveStatus,
  to: LiveStatus,
): LiveTransition => TABLE[from][to];

/** Whole seconds a stream ran; a stream cancelled before it started ran 0. */
export function durationSeconds(startedAt: Date | null, endedAt: Date): number {
  if (!startedAt) return 0;
  return Math.max(
    0,
    Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000),
  );
}
