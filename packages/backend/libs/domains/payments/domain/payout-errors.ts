import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';
import type { PayoutStatus } from './payout-state';

/**
 * Errors of the payouts (S15 contracts/http.md "Problem registry"). Every HTTP one is an `AppError` with a stable
 * `code`; the run, job and transient ones never reach a client. `permission_denied`, `invalid_cursor`,
 * `validation_failed` and the idempotency and rate-limit codes belong to the ledger, the payment domain and the
 * platform.
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

export class PayoutNotFound extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.NOT_FOUND,
        'payout_not_found',
        'Not found',
        'Payout not found.',
      ),
    );
  }
}

export class PayoutStateConflict extends AppError {
  constructor(readonly current: PayoutStatus) {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'payout_state_conflict',
        'Conflict',
        'The payout is not in a state that allows this.',
        { extensions: { details: { status: current } } },
      ),
    );
  }
}

export class DestinationInvalid extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'destination_invalid',
        'Unprocessable Entity',
        'The payout destination is not a valid provider account.',
      ),
    );
  }
}

/** Same definition as tenancy's: a shop that tenancy does not know. */
export class ShopNotFound extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.NOT_FOUND,
        'shop_not_found',
        'Not found',
        'Shop not found.',
      ),
    );
  }
}

/** The run refused its period (a job error, not an HTTP problem): not a Monday, in the future, malformed, too old. */
export class RunRefused extends Error {
  readonly code = 'period_invalid';
  constructor() {
    super('period_invalid');
    this.name = 'RunRefused';
  }
}

/** A send that the provider answered with a transient failure; the job layer retries it with the same key. */
export class TransientPayoutError extends Error {
  constructor(readonly outcome: string) {
    super(`transient provider outcome: ${outcome}`);
    this.name = 'TransientPayoutError';
  }
}

const entry = (
  code: string,
  status: number,
  title: string,
  detail: string,
): ProblemCatalogEntry => ({ code, status, title, detail, owner: 'payouts' });

export const PAYOUT_PROBLEMS: ProblemCatalogEntry[] = [
  entry('payout_not_found', 404, 'Not found', 'Payout not found.'),
  entry(
    'payout_state_conflict',
    409,
    'Conflict',
    'The payout is not in a state that allows this.',
  ),
  entry(
    'destination_invalid',
    422,
    'Unprocessable Entity',
    'The payout destination is not a valid provider account.',
  ),
  entry('shop_not_found', 404, 'Not found', 'Shop not found.'),
];
