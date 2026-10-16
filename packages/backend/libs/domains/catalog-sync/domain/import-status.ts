import {
  IMPORT_STATUSES,
  type ImportStatus,
} from '@marketplace-sandbox/contracts';
import { assertNever } from '@app/common/core/assert-never';

export { IMPORT_STATUSES, type ImportStatus };

/**
 * Import job state machine (S07 FR-037, AS-58). Pure: no framework, clock or I/O. Exactly 13 of the 56 ordered pairs
 * are allowed; the path is always UPLOADED -> SCANNING -> PROCESSING, also when the scan is skipped.
 *
 *   PENDING_UPLOAD -> UPLOADED | CANCELLED | EXPIRED | FAILED
 *   UPLOADED       -> SCANNING | CANCELLED | FAILED
 *   SCANNING       -> PROCESSING | CANCELLED | FAILED
 *   PROCESSING     -> DONE | CANCELLED | FAILED
 */
export const IMPORT_TRANSITIONS: Readonly<
  Record<ImportStatus, readonly ImportStatus[]>
> = {
  PENDING_UPLOAD: ['UPLOADED', 'CANCELLED', 'EXPIRED', 'FAILED'],
  UPLOADED: ['SCANNING', 'CANCELLED', 'FAILED'],
  SCANNING: ['PROCESSING', 'CANCELLED', 'FAILED'],
  PROCESSING: ['DONE', 'CANCELLED', 'FAILED'],
  DONE: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export const canTransition = (from: ImportStatus, to: ImportStatus): boolean =>
  IMPORT_TRANSITIONS[from].includes(to);

/**
 * A conditional transition applies `from -> to` to a job whose status is `current`: a `current` that is not `from`
 * is a stale writer (the store updates zero rows), a pair outside the table is illegal.
 */
export function checkTransition(
  current: ImportStatus,
  from: ImportStatus,
  to: ImportStatus,
): { ok: true } | { ok: false; reason: 'stale' | 'illegal' } {
  if (current !== from) return { ok: false, reason: 'stale' };
  return canTransition(from, to)
    ? { ok: true }
    : { ok: false, reason: 'illegal' };
}

export type FinalImportStatus = 'DONE' | 'FAILED' | 'CANCELLED' | 'EXPIRED';

/** No transition leaves a final status; its source file is deleted and its slot is free. */
export function isFinalImportStatus(
  status: ImportStatus,
): status is FinalImportStatus {
  switch (status) {
    case 'DONE':
    case 'FAILED':
    case 'CANCELLED':
    case 'EXPIRED':
      return true;
    case 'PENDING_UPLOAD':
    case 'UPLOADED':
    case 'SCANNING':
    case 'PROCESSING':
      return false;
    default:
      return assertNever(status);
  }
}

/** Non-final: holds one of the shop's three slots. */
export const isActiveImportStatus = (status: ImportStatus): boolean =>
  !isFinalImportStatus(status);

/** A worker is (or may be) reading the file: at most one such job per shop. */
export function isRunningImportStatus(status: ImportStatus): boolean {
  switch (status) {
    case 'SCANNING':
    case 'PROCESSING':
      return true;
    case 'PENDING_UPLOAD':
    case 'UPLOADED':
    case 'DONE':
    case 'FAILED':
    case 'CANCELLED':
    case 'EXPIRED':
      return false;
    default:
      return assertNever(status);
  }
}
