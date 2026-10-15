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

import Payout from './infra/models/payout.model';
import PayoutHistory from './infra/models/payout-history.model';
import PayoutRun from './infra/models/payout-run.model';
import PayoutDestination from './infra/models/payout-destination.model';
import PayoutDestinationHistory from './infra/models/payout-destination-history.model';
import PayoutReserve from './infra/models/payout-reserve.model';
import PayoutReserveHistory from './infra/models/payout-reserve-history.model';
import PayoutAuditDay from './infra/models/payout-audit-day.model';
import PayoutAuditFinding from './infra/models/payout-audit-finding.model';

/** The payout models (S15): no association, no foreign key, no model of another owner. */
export const PAYOUT_MODELS = [
  Payout,
  PayoutHistory,
  PayoutRun,
  PayoutDestination,
  PayoutDestinationHistory,
  PayoutReserve,
  PayoutReserveHistory,
  PayoutAuditDay,
  PayoutAuditFinding,
];

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
