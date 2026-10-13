import { defineEvent } from '@app/infrastructure/events/define-event';
import {
  journalPostedV2Schema,
  reconciliationCompletedSchema,
  reconciliationIssueOpenedSchema,
} from '@marketplace-sandbox/contracts';

/**
 * `ledger.events` (S14 contracts/events.md). `journal_posted` v2 carries each line's resulting balance and balance
 * version, so the read model applies absolute values (v1 carried deltas and is retired). The aggregate of a journal
 * event is the journal, of a run event the run, of an issue event the issue.
 */
export const JournalPosted = defineEvent(
  'ledger.journal_posted',
  'ledger',
  2,
  journalPostedV2Schema,
);

export const ReconciliationCompleted = defineEvent(
  'ledger.reconciliation_completed',
  'ledger',
  1,
  reconciliationCompletedSchema,
);

export const ReconciliationIssueOpened = defineEvent(
  'ledger.reconciliation_issue_opened',
  'ledger',
  1,
  reconciliationIssueOpenedSchema,
);
