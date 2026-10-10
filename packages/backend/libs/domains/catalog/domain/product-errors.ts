import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';

/**
 * Problem codes of S05 (contracts/http.md). Every class carries a stable snake_case `code`. Cross-shop and unknown
 * products answer the same `404` so existence cannot be probed (BOLA, AS-12).
 */
const domainError = (
  status: HttpStatus,
  code: string,
  title: string,
  detail: string,
  extensions?: Record<string, unknown>,
) =>
  ({
    status,
    code,
    title,
    detail,
    area: ErrorArea.DOMAIN,
    ...(extensions ? { extensions } : {}),
  }) as ConstructorParameters<typeof AppError>[0];

export class ProductNotFoundError extends AppError {
  /** `headers` lets the public route say how long a CDN may keep the answer (`Cache-Control: public, s-maxage=5`). */
  constructor(headers?: Record<string, string>) {
    super({
      ...domainError(
        HttpStatus.NOT_FOUND,
        'product_not_found',
        'Not found',
        'Product not found.',
      ),
      ...(headers ? { headers } : {}),
    });
  }
}

export class VersionConflictError extends AppError {
  constructor(readonly currentVersion: number) {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'version_conflict',
        'Conflict',
        'The product was changed by someone else; reload it and retry.',
        { currentVersion },
      ),
    );
  }
}

export class InvalidTransitionError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'invalid_transition',
        'Conflict',
        'The product is not in a state that allows this change.',
      ),
    );
  }
}

export class ProductArchivedError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'product_archived',
        'Conflict',
        'An archived product cannot be edited; restore it first.',
      ),
    );
  }
}

/** The shop is not `ACTIVE`: `SUSPENDED` answers 403, `DELETING` and `DELETED` 409 (the S03 gate codes). */
export class ShopNotActiveError extends AppError {
  constructor(readonly shopStatus: 'SUSPENDED' | 'DELETING' | 'DELETED') {
    super(
      shopStatus === 'SUSPENDED'
        ? domainError(
            HttpStatus.FORBIDDEN,
            'shop_suspended',
            'Forbidden',
            'The shop is suspended.',
          )
        : domainError(
            HttpStatus.CONFLICT,
            'shop_offboarding',
            'Conflict',
            'The shop is being closed.',
          ),
    );
  }
}

export class StockOperationConflictError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'stock_operation_conflict',
        'Conflict',
        'The operation id was already used for a different change.',
      ),
    );
  }
}

export class CurrencyNotSupportedError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'currency_not_supported',
        'Unprocessable',
        'The currency is not supported.',
      ),
    );
  }
}

export class InvalidCursorError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.BAD_REQUEST,
        'invalid_cursor',
        'Bad request',
        'The cursor is not valid for this list.',
      ),
    );
  }
}

/**
 * `503` for a cold read when the database cannot be reached: the platform's `database_unavailable` code, a generic
 * detail (no SQL, host or driver message) and `Retry-After`.
 */
export class DatabaseUnavailableError extends AppError {
  constructor(cause: Error) {
    super({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'database_unavailable',
      title: 'Service Unavailable',
      detail: 'The service is temporarily unavailable. Please retry.',
      area: ErrorArea.TRANSIENT,
      retryAfterSeconds: 1,
      causes: [cause],
    });
  }
}

const CONNECTION_FAILURE =
  /Connection(Error|Refused|TimedOut|AcquireTimeout)|ECONN|ETIMEDOUT|EPIPE|terminated unexpectedly|socket hang up|Connection terminated/i;

/** Whether an error says "the database is not reachable" (as opposed to a rejected statement). */
export const isConnectionFailure = (error: unknown): error is Error =>
  error instanceof Error &&
  (CONNECTION_FAILURE.test(error.name) ||
    CONNECTION_FAILURE.test(error.message) ||
    (error.cause !== undefined && isConnectionFailure(error.cause)) ||
    isConnectionFailure((error as { original?: unknown }).original));

/** `400 validation_failed` naming the offending fields (never their values). */
export class ProductValidationError extends AppError {
  constructor(fields: string[]) {
    super(
      domainError(
        HttpStatus.BAD_REQUEST,
        'validation_failed',
        'Bad request',
        'The request is not valid.',
        { errors: fields.map((field) => ({ field, code: 'invalid' })) },
      ),
    );
  }
}
