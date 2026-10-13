import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';

/**
 * Errors of the ledger (S14 contracts/services.md). Every one is an `AppError` with a stable `code`. A posting that
 * fails after its first write carries `rollbackRequired`: the caller's transaction must roll back (research R-4).
 */
type Params = ConstructorParameters<typeof AppError>[0];

const domainError = (
  status: HttpStatus,
  code: string,
  title: string,
  detail: string,
  extra: Partial<Params> = {},
): Params => ({
  status,
  code,
  title,
  detail,
  area: ErrorArea.DOMAIN,
  ...extra,
});

export type JournalInvalidReason =
  | 'journal_too_few_lines'
  | 'journal_too_large'
  | 'line_amount_zero'
  | 'line_amount_invalid'
  | 'journal_currency_mismatch'
  | 'currency_invalid'
  | 'currency_unsupported'
  | 'account_unknown'
  | 'kind_not_allowed'
  | 'reference_invalid'
  | 'amount_not_above_fee'
  | 'sale_not_found'
  | 'refund_amount_mismatch'
  | 'balance_overflow'
  | 'too_many_accounts';

const REASON_DETAIL: Record<JournalInvalidReason, string> = {
  journal_too_few_lines: 'A journal needs at least 2 lines.',
  journal_too_large: 'A journal has at most 200 lines.',
  line_amount_zero: 'A journal line must not be zero.',
  line_amount_invalid: 'A journal line must be a whole number of minor units.',
  journal_currency_mismatch: 'All lines of a journal share one currency.',
  currency_invalid: 'The currency must be a three-letter upper-case code.',
  currency_unsupported: 'The currency is not supported.',
  account_unknown: 'A journal line names an unknown account.',
  kind_not_allowed: 'This journal kind cannot be posted by the caller.',
  reference_invalid: 'The journal reference is empty, too long or malformed.',
  amount_not_above_fee: 'The amount is not above the platform fee.',
  sale_not_found: 'No sale was recorded for this payment.',
  refund_amount_mismatch: 'The refund must be for the full amount of the sale.',
  balance_overflow: 'A balance would leave the safe integer range.',
  too_many_accounts: 'At most 500 accounts per call.',
};

/** The `code` of this error is the reason itself, so `ledger_post_rejected_total{reason}` and the code agree. */
export class JournalInvalid extends AppError {
  /** Set when the failure happened after a write of the posting (`balance_overflow`). */
  rollbackRequired = false;
  constructor(readonly reason: JournalInvalidReason) {
    super(
      domainError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        reason,
        'Unprocessable Entity',
        REASON_DETAIL[reason],
        { extensions: { reason } },
      ),
    );
    if (reason === 'balance_overflow') this.rollbackRequired = true;
  }
}

export class JournalUnbalanced extends AppError {
  readonly rollbackRequired = false;
  constructor(readonly sum: number) {
    super(
      domainError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'journal_unbalanced',
        'Unprocessable Entity',
        'The lines of the journal do not sum to zero.',
        { extensions: { sum } },
      ),
    );
  }
}

export class JournalConflict extends AppError {
  readonly rollbackRequired = false;
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'journal_conflict',
        'Conflict',
        'A journal with this kind and reference exists with other lines.',
      ),
    );
  }
}

export class InsufficientBalance extends AppError {
  readonly rollbackRequired = true;
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'insufficient_balance',
        'Conflict',
        'The balance does not cover this posting.',
      ),
    );
  }
}

export class LedgerBusy extends AppError {
  readonly rollbackRequired = true;
  constructor() {
    super(
      domainError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'ledger_busy',
        'Service Unavailable',
        'The ledger is busy; try again.',
        { retryAfterSeconds: 1 },
      ),
    );
  }
}

export class TransactionRequired extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'transaction_required',
        'Internal Server Error',
        'A ledger posting needs the caller transaction.',
      ),
    );
  }
}

export class PermissionDenied extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.FORBIDDEN,
        'permission_denied',
        'Forbidden',
        'You do not have permission to do this.',
      ),
    );
  }
}

export class ReconciliationIssueNotFound extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.NOT_FOUND,
        'reconciliation_issue_not_found',
        'Not found',
        'Reconciliation issue not found.',
      ),
    );
  }
}

export class IssueAlreadyResolved extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'issue_already_resolved',
        'Conflict',
        'The reconciliation issue is already resolved.',
      ),
    );
  }
}

export type AdjustmentProblem =
  | 'adjustment_unbalanced'
  | 'adjustment_account_invalid'
  | 'adjustment_too_large';

const ADJUSTMENT_DETAIL: Record<AdjustmentProblem, string> = {
  adjustment_unbalanced: 'The adjustment lines do not sum to zero.',
  adjustment_account_invalid: 'The adjustment names an unknown account.',
  adjustment_too_large: 'An adjustment has at most 10 lines.',
};

/** The three `422` answers of a resolve request whose adjustment cannot be posted (contracts/http.md). */
export class AdjustmentInvalid extends AppError {
  constructor(readonly problem: AdjustmentProblem) {
    super(
      domainError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        problem,
        'Unprocessable Entity',
        ADJUSTMENT_DETAIL[problem],
      ),
    );
  }
}

const entry = (
  code: string,
  status: number,
  title: string,
  detail: string,
): ProblemCatalogEntry => ({ code, status, title, detail, owner: 'ledger' });

/** HTTP-visible codes of the ledger and the operator API (contracts/http.md); registered at module definition. */
export const LEDGER_PROBLEMS: ProblemCatalogEntry[] = [
  entry(
    'reconciliation_issue_not_found',
    404,
    'Not found',
    'Reconciliation issue not found.',
  ),
  entry(
    'issue_already_resolved',
    409,
    'Conflict',
    'The reconciliation issue is already resolved.',
  ),
  entry(
    'adjustment_unbalanced',
    422,
    'Unprocessable Entity',
    'The adjustment lines do not sum to zero.',
  ),
  entry(
    'adjustment_account_invalid',
    422,
    'Unprocessable Entity',
    'The adjustment names an unknown account.',
  ),
  entry(
    'adjustment_too_large',
    422,
    'Unprocessable Entity',
    'The adjustment has too many lines.',
  ),
  entry(
    'ledger_busy',
    503,
    'Service Unavailable',
    'The ledger is busy; try again.',
  ),
  entry(
    'insufficient_balance',
    409,
    'Conflict',
    'The balance does not cover this posting.',
  ),
];
