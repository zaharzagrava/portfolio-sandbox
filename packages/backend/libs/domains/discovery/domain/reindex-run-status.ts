import { assertNever } from '@app/common/core/assert-never';

export const REINDEX_RUN_STATUSES = [
  'QUEUED',
  'BUILDING',
  'CATCHING_UP',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type ReindexRunStatus = (typeof REINDEX_RUN_STATUSES)[number];

export type RunMove =
  { ok: true; to: ReindexRunStatus } | { ok: false; code: 'invalid_transition' };

/** Statuses a run in `from` may move to (AS-82). Terminal statuses have none. */
export function nextStatuses(from: ReindexRunStatus): ReindexRunStatus[] {
  switch (from) {
    case 'QUEUED':
      return ['BUILDING', 'CANCELLED'];
    case 'BUILDING':
      return ['CATCHING_UP', 'FAILED', 'CANCELLED'];
    case 'CATCHING_UP':
      return ['COMPLETED', 'FAILED', 'CANCELLED'];
    case 'COMPLETED':
    case 'FAILED':
    case 'CANCELLED':
      return [];
    default:
      return assertNever(from);
  }
}

export function transition(
  from: ReindexRunStatus,
  to: ReindexRunStatus,
): RunMove {
  return nextStatuses(from).includes(to)
    ? { ok: true, to }
    : { ok: false, code: 'invalid_transition' };
}

/** Active runs hold the single-active-run slot (III.6). */
export function isActive(status: ReindexRunStatus): boolean {
  switch (status) {
    case 'QUEUED':
    case 'BUILDING':
    case 'CATCHING_UP':
      return true;
    case 'COMPLETED':
    case 'FAILED':
    case 'CANCELLED':
      return false;
    default:
      return assertNever(status);
  }
}

export const isTerminal = (status: ReindexRunStatus): boolean =>
  !isActive(status);
