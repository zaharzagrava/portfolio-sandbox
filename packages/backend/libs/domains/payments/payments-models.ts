import Payment from './infra/models/payment.model';
import PaymentHistory from './infra/models/payment-history.model';
import PayableOrder from './infra/models/payable-order.model';
import LedgerEntry from './infra/models/ledger-entry.model';
import LedgerJournal from './infra/models/ledger-journal.model';
import AccountBalance from './infra/models/account-balance.model';
import LedgerCheckpoint from './infra/models/ledger-checkpoint.model';
import LedgerBackfillCursor from './infra/models/ledger-backfill-cursor.model';
import ProviderAccount from './infra/models/provider-account.model';
import ReconciliationRun from './infra/models/reconciliation-run.model';
import ReconciliationIssue from './infra/models/reconciliation-issue.model';
import ReconciliationIssueHistory from './infra/models/reconciliation-issue-history.model';
import ReconciliationStaging from './infra/models/reconciliation-staging.model';
import ReconciliationSeen from './infra/models/reconciliation-seen.model';

/** The payment-intent models this domain owns (no model of another owner: IX.4). */
export const PAYMENT_MODELS = [Payment, PaymentHistory, PayableOrder];

/** The ledger and reconciliation models (S14): no association, no foreign model. */
export const LEDGER_MODELS = [
  LedgerEntry,
  LedgerJournal,
  AccountBalance,
  LedgerCheckpoint,
  LedgerBackfillCursor,
  ProviderAccount,
  ReconciliationRun,
  ReconciliationIssue,
  ReconciliationIssueHistory,
  ReconciliationStaging,
  ReconciliationSeen,
];
