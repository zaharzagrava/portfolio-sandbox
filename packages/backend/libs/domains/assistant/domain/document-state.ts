import { KNOWLEDGE_STATUSES } from '@marketplace-sandbox/contracts';

export type DocumentStatus = (typeof KNOWLEDGE_STATUSES)[number];

/**
 * The only legal moves of a knowledge document (S47 FR-003, research R-4). Every move is a conditional update that
 * asserts the prior state; this table is what the repository statements and the service rules are checked against.
 *
 *   AWAITING_UPLOAD → QUEUED            the client says the bytes are uploaded
 *   QUEUED → PROCESSING                 a worker claims the task (lease)
 *   PROCESSING → READY | FAILED         the worker commits, or fails deterministically
 *   PROCESSING → QUEUED                 transient failure, or an expired lease released by the sweep
 *   FAILED → QUEUED                     retry; READY → QUEUED: re-index
 *   any non-final → DELETED             final; a tombstone stays for 30 days
 */
export const nextStatuses: Record<DocumentStatus, readonly DocumentStatus[]> = {
  AWAITING_UPLOAD: ['QUEUED', 'DELETED'],
  QUEUED: ['PROCESSING', 'DELETED'],
  PROCESSING: ['READY', 'FAILED', 'QUEUED', 'DELETED'],
  READY: ['QUEUED', 'DELETED'],
  FAILED: ['QUEUED', 'DELETED'],
  DELETED: [],
};

export const canMove = (from: DocumentStatus, to: DocumentStatus): boolean =>
  nextStatuses[from].includes(to);
