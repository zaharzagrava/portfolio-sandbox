import { parseRungTask } from './dag';
import type { FailureCode, PermanentFailureCode } from './video-errors';

/**
 * Time limits, attempts and backoff of the pipeline tasks (S30 FR-026, FR-028, AS-24, AS-25, R-7, R-9). Pure.
 *
 * Exports:
 *  - `MAX_ATTEMPTS` (3 per task), `MAX_VIDEO_RETRIES` (3 seller retries), `LEASE_MS` (5 min), `HEARTBEAT_MS` (60 s),
 *    `SQS_VISIBILITY_SEC` (900), `STUCK_RESEND_GUARD_MS` (1 min), `PROCESSING_LIMIT_MS` (6 h).
 *  - `backoffSec(attempt)`: delay of the message that follows failed attempt `attempt` (1 -> 30 s, 2 -> 120 s);
 *    null when no attempt is left.
 *  - `taskTimeoutMs(task, durationSec)`: transcode `max(600 s, 3 x duration)` capped at 3 h; probe 60 s; poster and
 *    thumbnails 120 s; package 60 s; publish 60 s. Unknown task names throw.
 *  - `nextAfterFailure({failure, attempt, optional})`: retry / fail(code) / skip / requeue decision.
 */
export const MAX_ATTEMPTS = 3;
export const MAX_VIDEO_RETRIES = 3;
export const LEASE_MS = 5 * 60 * 1000;
export const HEARTBEAT_MS = 60 * 1000;
export const SQS_VISIBILITY_SEC = 900;
export const STUCK_RESEND_GUARD_MS = 60 * 1000;
export const PROCESSING_LIMIT_MS = 6 * 60 * 60 * 1000;

const BACKOFF_SEC = [30, 120] as const;

export function backoffSec(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1)
    throw new RangeError(`attempt must be a positive integer, got ${attempt}`);
  return BACKOFF_SEC[attempt - 1] ?? null;
}

const TRANSCODE_FLOOR_MS = 600 * 1000;
const TRANSCODE_CAP_MS = 3 * 60 * 60 * 1000;

const FIXED_LIMIT_MS: Record<string, number> = {
  probe: 60 * 1000,
  poster: 120 * 1000,
  thumbnails: 120 * 1000,
  package: 60 * 1000,
  publish: 60 * 1000,
};

export function taskTimeoutMs(task: string, durationSec: number): number {
  const fixed = FIXED_LIMIT_MS[task];
  if (fixed !== undefined) return fixed;
  if (parseRungTask(task) === null)
    throw new Error(`no time limit defined for task ${task}`);
  if (!Number.isFinite(durationSec) || durationSec < 0)
    return TRANSCODE_FLOOR_MS;
  return Math.min(
    TRANSCODE_CAP_MS,
    Math.max(TRANSCODE_FLOOR_MS, Math.round(3 * durationSec * 1000)),
  );
}

/** Why an attempt ended (R-9). `permanent` carries its own failure code and is never retried. */
export type AttemptFailure =
  | { kind: 'transient' }
  | { kind: 'storage' }
  | { kind: 'timeout' }
  | { kind: 'shutdown' }
  | { kind: 'permanent'; code: PermanentFailureCode };

export type AfterFailure =
  | { action: 'retry'; delaySec: number }
  | { action: 'fail'; failureCode: FailureCode }
  | { action: 'skip' }
  /** Shutdown: back to QUEUED at once, the attempt is not counted. */
  | { action: 'requeue' };

export function nextAfterFailure(p: {
  failure: AttemptFailure;
  /** The attempt that just ended, 1-based. */
  attempt: number;
  optional: boolean;
}): AfterFailure {
  const { failure, attempt } = p;
  if (failure.kind === 'shutdown') return { action: 'requeue' };
  if (failure.kind === 'permanent')
    return { action: 'fail', failureCode: failure.code };
  const delaySec = backoffSec(attempt);
  if (delaySec !== null && attempt < MAX_ATTEMPTS)
    return { action: 'retry', delaySec };
  if (p.optional) return { action: 'skip' };
  const failureCode: FailureCode =
    failure.kind === 'storage'
      ? 'storage_unavailable'
      : failure.kind === 'timeout'
        ? 'task_timeout'
        : 'transcode_failed';
  return { action: 'fail', failureCode };
}
