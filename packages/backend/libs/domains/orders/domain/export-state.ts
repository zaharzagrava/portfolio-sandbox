import { assertNever } from '@app/common/core/assert-never';

/**
 * Export job state machine (S12 FR-002, AS-61). Pure: no framework, clock or I/O (FR-039).
 *
 *   QUEUED ──claim──► RUNNING ──► DONE ──retention──► EXPIRED
 *     │ ▲                │ │
 *     │ └─retry/lease/───┘ ├──► FAILED
 *     │   shutdown         └──► CANCELLED
 *     └──cancel──► CANCELLED
 */
export const EXPORT_STATUSES = [
  'QUEUED',
  'RUNNING',
  'DONE',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

/** The statuses reachable from each status; every key of the union must be present. */
export const EXPORT_TRANSITIONS: Readonly<
  Record<ExportStatus, readonly ExportStatus[]>
> = {
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['DONE', 'FAILED', 'CANCELLED', 'QUEUED'],
  DONE: ['EXPIRED'],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export const canTransition = (from: ExportStatus, to: ExportStatus): boolean =>
  EXPORT_TRANSITIONS[from].includes(to);

/** Terminal: no further transition leaves the status. `DONE` is final for the run but still expires. */
export function isTerminalExportStatus(status: ExportStatus): boolean {
  switch (status) {
    case 'FAILED':
    case 'CANCELLED':
    case 'EXPIRED':
      return true;
    case 'QUEUED':
    case 'RUNNING':
    case 'DONE':
      return false;
    default:
      return assertNever(status);
  }
}

/** `QUEUED` and `RUNNING` hold the per-shop active slot (FR-003). */
export const isActiveExportStatus = (status: ExportStatus): boolean =>
  status === 'QUEUED' || status === 'RUNNING';
