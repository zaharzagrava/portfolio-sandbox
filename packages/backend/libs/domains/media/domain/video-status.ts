/**
 * The status machine of a product video (S30 FR-056, data-model.md "Status machine"). Pure: no framework, no clock.
 *
 * Exports (imported by the repositories and services):
 *  - `VIDEO_STATUSES` / `VideoStatus`: closed union, mirrors the `Video.status` CHECK.
 *  - `nextVideoStatuses(from)`, `canTransitionVideo(from, to)`, `assertVideoTransition(from, to)` (throws
 *    `IllegalVideoTransitionError`), `isTerminalVideoStatus(status)`.
 *  - `VIDEO_VISIBILITIES`, `VIDEO_CONTENT_TYPES`, `STATUS_ACTOR_TYPES`: the other closed vocabularies behind CHECK
 *    constraints; `sqlCheckList(values)` renders `'a','b'` for a migration so the DB and TypeScript cannot drift.
 *  - `assertNever`: for exhaustive switches.
 * Task statuses live in `dag.ts`, failure codes in `video-errors.ts`.
 */
export const VIDEO_STATUSES = [
  'UPLOADING',
  'UPLOADED',
  'PROCESSING',
  'READY',
  'FAILED',
  'EXPIRED',
  'DELETED',
] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];

export const VIDEO_VISIBILITIES = ['public', 'unlisted'] as const;
export type VideoVisibility = (typeof VIDEO_VISIBILITIES)[number];

export const VIDEO_CONTENT_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
] as const;
export type VideoContentType = (typeof VIDEO_CONTENT_TYPES)[number];

/** `VideoStatusHistory.actorType`. */
export const STATUS_ACTOR_TYPES = ['user', 'system', 'worker'] as const;
export type StatusActorType = (typeof STATUS_ACTOR_TYPES)[number];

export const assertNever = (value: never): never => {
  throw new Error(`unhandled case: ${String(value)}`);
};

/** `'a','b'` for a SQL `CHECK (col IN (...))`; values are code constants, never user input. */
export const sqlCheckList = (values: readonly string[]): string =>
  values.map((v) => `'${v}'`).join(',');

/** Statuses reachable from `from`: the whole table of FR-056 (any status except DELETED may be deleted). */
export const nextVideoStatuses = (
  from: VideoStatus,
): readonly VideoStatus[] => {
  switch (from) {
    case 'UPLOADING':
      return ['UPLOADED', 'EXPIRED', 'DELETED'];
    case 'UPLOADED':
      return ['PROCESSING', 'FAILED', 'DELETED'];
    case 'PROCESSING':
      return ['READY', 'FAILED', 'DELETED'];
    case 'FAILED':
      return ['PROCESSING', 'DELETED'];
    case 'READY':
    case 'EXPIRED':
      return ['DELETED'];
    case 'DELETED':
      return [];
    default:
      return assertNever(from);
  }
};

export class IllegalVideoTransitionError extends Error {
  constructor(
    readonly from: VideoStatus,
    readonly to: VideoStatus,
  ) {
    super(`illegal video transition ${from} -> ${to}`);
    this.name = 'IllegalVideoTransitionError';
  }
}

export const canTransitionVideo = (
  from: VideoStatus,
  to: VideoStatus,
): boolean => nextVideoStatuses(from).includes(to);

export const assertVideoTransition = (
  from: VideoStatus,
  to: VideoStatus,
): void => {
  if (!canTransitionVideo(from, to))
    throw new IllegalVideoTransitionError(from, to);
};

/** `DELETED` is terminal: no transition leaves it. */
export const isTerminalVideoStatus = (status: VideoStatus): boolean =>
  nextVideoStatuses(status).length === 0;
