import { assertNever } from '@app/common/core/assert-never';

/** Document status machine (S04 data-model.md, AS-70). Pure; see `application-status.ts` for how it is applied. */
export const DOCUMENT_STATUSES = [
  'AWAITING_UPLOAD',
  'QUEUED',
  'EXTRACTING',
  'NEEDS_REVIEW',
  'APPROVED',
  'REJECTED',
  'SUPERSEDED',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const DOCUMENT_EVENTS = [
  'CONFIRM_UPLOAD',
  'CLAIM',
  'APPROVE',
  'ROUTE_TO_REVIEW',
  'REJECT',
  'SUPERSEDE',
] as const;
export type DocumentEvent = (typeof DOCUMENT_EVENTS)[number];

/** The status `event` leads to from `from`, or `null` when the pair is not a transition. */
export function nextDocumentStatus(
  from: DocumentStatus,
  event: DocumentEvent,
): DocumentStatus | null {
  switch (from) {
    case 'AWAITING_UPLOAD':
      return event === 'CONFIRM_UPLOAD' ? 'QUEUED' : null;
    case 'QUEUED':
      if (event === 'CLAIM') return 'EXTRACTING';
      return event === 'SUPERSEDE' ? 'SUPERSEDED' : null;
    case 'EXTRACTING':
      if (event === 'APPROVE') return 'APPROVED';
      if (event === 'ROUTE_TO_REVIEW') return 'NEEDS_REVIEW';
      return event === 'SUPERSEDE' ? 'SUPERSEDED' : null;
    case 'NEEDS_REVIEW':
      if (event === 'APPROVE') return 'APPROVED';
      if (event === 'REJECT') return 'REJECTED';
      return event === 'SUPERSEDE' ? 'SUPERSEDED' : null;
    case 'REJECTED':
      return event === 'SUPERSEDE' ? 'SUPERSEDED' : null;
    case 'APPROVED':
    case 'SUPERSEDED':
      return null;
    default:
      return assertNever(from);
  }
}
