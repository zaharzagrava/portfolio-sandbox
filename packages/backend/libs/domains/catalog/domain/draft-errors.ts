import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { DraftStatus } from './draft-status';

/**
 * Problem codes of S06 (contracts/http.md). Every class carries a stable snake_case `code`. A draft or version of another
 * shop is indistinguishable from an unknown one (`404`, same body).
 */
const domainError = (
  status: HttpStatus,
  code: string,
  title: string,
  detail: string,
  extensions?: Record<string, unknown>,
  extra: Partial<ConstructorParameters<typeof AppError>[0]> = {},
) =>
  ({
    status,
    code,
    title,
    detail,
    area: ErrorArea.DOMAIN,
    ...(extensions ? { extensions } : {}),
    ...extra,
  }) as ConstructorParameters<typeof AppError>[0];

export class DraftNotFoundError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.NOT_FOUND,
        'draft_not_found',
        'Not found',
        'Draft not found.',
      ),
    );
  }
}

export class VersionNotFoundError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.NOT_FOUND,
        'version_not_found',
        'Not found',
        'Version not found.',
      ),
    );
  }
}

/** `400 validation_failed` naming the offending fields (never their values). */
export class DraftValidationError extends AppError {
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

export class DraftLimitReachedError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'draft_limit_reached',
        'Conflict',
        'The shop already has the maximum number of open drafts.',
      ),
    );
  }
}

export class VersionLimitReachedError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'version_limit_reached',
        'Conflict',
        'The draft already has the maximum number of versions.',
      ),
    );
  }
}

export class DraftInvalidTransitionError extends AppError {
  constructor(readonly currentStatus: DraftStatus) {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'invalid_transition',
        'Conflict',
        'The draft is not in a state that allows this change.',
        { currentStatus },
      ),
    );
  }
}

export class PublishInProgressError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'publish_in_progress',
        'Conflict',
        'The draft is being published.',
      ),
    );
  }
}

export class ProductVersionConflictError extends AppError {
  constructor(readonly currentVersion: number) {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'product_version_conflict',
        'Conflict',
        'The product changed since the draft started; review it and acknowledge its current version.',
        { currentVersion },
      ),
    );
  }
}

/** The product a draft targets is gone (deleted): publish answers 409, unlike the 404 of the product routes. */
export class ProductGoneError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'product_not_found',
        'Conflict',
        'The product this draft targets no longer exists.',
      ),
    );
  }
}

export interface ListingProblem {
  field: string;
  code: 'required' | 'invalid';
}

export class ListingInvalidError extends AppError {
  constructor(readonly errors: ListingProblem[]) {
    super(
      domainError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'listing_invalid',
        'Unprocessable',
        'The listing cannot be published as it is.',
        { errors },
      ),
    );
  }
}

/** No editing instance is registered, or the owner did not confirm in time. */
export class CollabUnavailableError extends AppError {
  constructor(cause?: Error) {
    super(
      domainError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'collab_unavailable',
        'Service Unavailable',
        'The editing service is temporarily unavailable. Please retry.',
        undefined,
        {
          area: ErrorArea.TRANSIENT,
          retryAfterSeconds: 5,
          ...(cause ? { causes: [cause] } : {}),
        },
      ),
    );
  }
}

/** The snapshot of a version cannot be read: generic detail, no storage message. */
export class VersionUnavailableError extends AppError {
  constructor(cause?: Error) {
    super(
      domainError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'version_unavailable',
        'Service Unavailable',
        'The version cannot be read right now. Please retry.',
        undefined,
        {
          area: ErrorArea.TRANSIENT,
          retryAfterSeconds: 5,
          ...(cause ? { causes: [cause] } : {}),
        },
      ),
    );
  }
}
