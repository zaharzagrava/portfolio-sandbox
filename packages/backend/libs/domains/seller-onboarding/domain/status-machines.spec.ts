import {
  APPLICATION_EVENTS,
  APPLICATION_STATUSES,
  type ApplicationEvent,
  type ApplicationStatus,
  nextApplicationStatus,
} from './application-status';
import {
  DOCUMENT_EVENTS,
  DOCUMENT_STATUSES,
  type DocumentEvent,
  type DocumentStatus,
  nextDocumentStatus,
} from './document-status';
import {
  REVIEW_TASK_EVENTS,
  REVIEW_TASK_STATUSES,
  type ReviewTaskEvent,
  type ReviewTaskStatus,
  nextReviewTaskStatus,
} from './review-task-status';

type Table<S extends string, E extends string> = Partial<
  Record<S, Partial<Record<E, S>>>
>;

/** Every (state, event) pair: the listed ones move, all others are refused (null). */
function pairs<S extends string, E extends string>(
  statuses: readonly S[],
  events: readonly E[],
  allowed: Table<S, E>,
): [S, E, S | null][] {
  return statuses.flatMap((s) =>
    events.map((e): [S, E, S | null] => [s, e, allowed[s]?.[e] ?? null]),
  );
}

describe('application status machine', () => {
  const allowed: Table<ApplicationStatus, ApplicationEvent> = {
    SUBMITTED: { VERIFY: 'VERIFIED', REJECT: 'REJECTED' },
    REJECTED: { RESUBMIT: 'SUBMITTED' },
  };

  it.each(pairs(APPLICATION_STATUSES, APPLICATION_EVENTS, allowed))(
    'S04 AS-70: %s + %s -> %s',
    (from, event, to) => {
      expect(nextApplicationStatus(from, event)).toBe(to);
    },
  );

  it('S04 AS-70: VERIFIED accepts nothing', () => {
    for (const e of APPLICATION_EVENTS)
      expect(nextApplicationStatus('VERIFIED', e)).toBeNull();
  });

  it('S04 AS-70: the table covers every pair', () => {
    expect(
      pairs(APPLICATION_STATUSES, APPLICATION_EVENTS, allowed),
    ).toHaveLength(APPLICATION_STATUSES.length * APPLICATION_EVENTS.length);
  });
});

describe('document status machine', () => {
  const allowed: Table<DocumentStatus, DocumentEvent> = {
    AWAITING_UPLOAD: { CONFIRM_UPLOAD: 'QUEUED' },
    QUEUED: { CLAIM: 'EXTRACTING', SUPERSEDE: 'SUPERSEDED' },
    EXTRACTING: {
      APPROVE: 'APPROVED',
      ROUTE_TO_REVIEW: 'NEEDS_REVIEW',
      SUPERSEDE: 'SUPERSEDED',
    },
    NEEDS_REVIEW: {
      APPROVE: 'APPROVED',
      REJECT: 'REJECTED',
      SUPERSEDE: 'SUPERSEDED',
    },
    REJECTED: { SUPERSEDE: 'SUPERSEDED' },
  };

  it.each(pairs(DOCUMENT_STATUSES, DOCUMENT_EVENTS, allowed))(
    'S04 AS-70: %s + %s -> %s',
    (from, event, to) => {
      expect(nextDocumentStatus(from, event)).toBe(to);
    },
  );

  it('S04 AS-70: QUEUED cannot go straight to NEEDS_REVIEW (the dead-letter handler claims first)', () => {
    expect(nextDocumentStatus('QUEUED', 'ROUTE_TO_REVIEW')).toBeNull();
  });

  it.each(['APPROVED', 'SUPERSEDED'] as const)(
    'S04 AS-70: %s is terminal',
    (s) => {
      for (const e of DOCUMENT_EVENTS)
        expect(nextDocumentStatus(s, e)).toBeNull();
    },
  );
});

describe('review task status machine', () => {
  const allowed: Table<ReviewTaskStatus, ReviewTaskEvent> = {
    OPEN: { APPROVE: 'APPROVED', REJECT: 'REJECTED', CANCEL: 'CANCELLED' },
  };

  it.each(pairs(REVIEW_TASK_STATUSES, REVIEW_TASK_EVENTS, allowed))(
    'S04 AS-70: %s + %s -> %s',
    (from, event, to) => {
      expect(nextReviewTaskStatus(from, event)).toBe(to);
    },
  );
});
