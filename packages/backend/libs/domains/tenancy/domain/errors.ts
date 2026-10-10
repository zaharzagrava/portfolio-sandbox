import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';

/**
 * FR-100 problem codes of S03. Every class carries a stable snake_case `code`; the detail text never names a
 * permission, a shop id or a member. Not-found answers are uniform so existence cannot be probed (BOLA, AS-09).
 */
const domainError = (
  status: HttpStatus,
  code: string,
  title: string,
  detail: string,
  extra: Partial<ConstructorParameters<typeof AppError>[0]> = {},
) =>
  ({
    status,
    code,
    title,
    detail,
    area: ErrorArea.DOMAIN,
    ...extra,
  }) as ConstructorParameters<typeof AppError>[0];

export class Domain_ShopNotFoundError extends AppError {
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

export class Domain_ShopMismatchError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.BAD_REQUEST,
        'shop_mismatch',
        'Bad request',
        'The shop in the header does not match the shop in the path.',
      ),
    );
  }
}

export class Domain_PermissionDeniedError extends AppError {
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

export class Domain_InsufficientRoleError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.FORBIDDEN,
        'insufficient_role',
        'Forbidden',
        'Your role does not allow this change.',
      ),
    );
  }
}

export class Domain_ShopSuspendedError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.FORBIDDEN,
        'shop_suspended',
        'Forbidden',
        'This shop is suspended.',
      ),
    );
  }
}

export class Domain_ShopOffboardingError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'shop_offboarding',
        'Conflict',
        'This shop is being closed.',
      ),
    );
  }
}

export class Domain_SlugTakenError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'slug_taken',
        'Conflict',
        'This slug is already taken.',
      ),
    );
  }
}

export class Domain_SlugReservedError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'slug_reserved',
        'Unprocessable entity',
        'This slug is reserved.',
      ),
    );
  }
}

export class Domain_RegionNotAllowedError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'region_not_allowed',
        'Unprocessable entity',
        'This region is not available.',
      ),
    );
  }
}

export class Domain_ShopLimitReachedError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'shop_limit_reached',
        'Conflict',
        'You own the maximum number of shops.',
      ),
    );
  }
}

export class Domain_MemberNotFoundError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.NOT_FOUND,
        'member_not_found',
        'Not found',
        'Member not found.',
      ),
    );
  }
}

export class Domain_LastOwnerError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'last_owner',
        'Conflict',
        'A shop must keep at least one owner.',
      ),
    );
  }
}

export class Domain_SerializationFailureError extends AppError {
  constructor(cause?: Error) {
    super(
      domainError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'serialization_failure',
        'Service unavailable',
        'The request conflicted with a concurrent update. Please retry.',
        {
          area: ErrorArea.TRANSIENT,
          retryAfterSeconds: 1,
          causes: cause ? [cause] : undefined,
        },
      ),
    );
  }
}

export class Domain_AlreadyMemberError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'already_member',
        'Conflict',
        'This person is already a member.',
      ),
    );
  }
}

export class Domain_InvitePendingError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'invite_pending',
        'Conflict',
        'An invitation for this address is already pending.',
      ),
    );
  }
}

export class Domain_SeatLimitReachedError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'seat_limit_reached',
        'Conflict',
        'The plan has no free seat.',
      ),
    );
  }
}

/** The one answer for every way an invitation can be unusable (AS-33). */
export class Domain_InviteNotFoundError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.NOT_FOUND,
        'invite_not_found',
        'Not found',
        'The invitation was not found or is no longer valid.',
      ),
    );
  }
}

export class Domain_InvalidTransitionError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'invalid_transition',
        'Conflict',
        'This change is not allowed in the current state.',
      ),
    );
  }
}

export class Domain_UnknownCellError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'unknown_cell',
        'Unprocessable entity',
        'The cell is not configured.',
      ),
    );
  }
}

export class Domain_CellUnavailableError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'cell_unavailable',
        'Service unavailable',
        'The shop is temporarily unavailable.',
        { area: ErrorArea.TRANSIENT, retryAfterSeconds: 5 },
      ),
    );
  }
}

export class Domain_ConfirmationMismatchError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'confirmation_mismatch',
        'Unprocessable entity',
        'The confirmation does not match.',
      ),
    );
  }
}

export class Domain_StaleVersionError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'stale_version',
        'Conflict',
        'The resource changed; reload and retry.',
      ),
    );
  }
}

/** A malformed query parameter (cursor, limit, status): the same `validation_failed` the body pipe produces. */
export class Domain_InvalidQueryError extends AppError {
  constructor(field: string, code: string) {
    super(
      domainError(
        HttpStatus.BAD_REQUEST,
        'validation_failed',
        'Bad Request',
        'The request is not valid.',
        { extensions: { errors: [{ field, code }] } },
      ),
    );
  }
}

export class Domain_TooManyIdsError extends AppError {
  constructor(max: number) {
    super(
      domainError(
        HttpStatus.BAD_REQUEST,
        'validation_failed',
        'Bad request',
        `At most ${max} ids are accepted.`,
      ),
    );
  }
}

/** All codes of the domain, for the problem catalog (S54 AS-12). */
export const TENANCY_PROBLEMS = [
  new Domain_ShopNotFoundError(),
  new Domain_ShopMismatchError(),
  new Domain_PermissionDeniedError(),
  new Domain_InsufficientRoleError(),
  new Domain_ShopSuspendedError(),
  new Domain_ShopOffboardingError(),
  new Domain_SlugTakenError(),
  new Domain_SlugReservedError(),
  new Domain_RegionNotAllowedError(),
  new Domain_ShopLimitReachedError(),
  new Domain_MemberNotFoundError(),
  new Domain_LastOwnerError(),
  new Domain_SerializationFailureError(),
  new Domain_AlreadyMemberError(),
  new Domain_InvitePendingError(),
  new Domain_SeatLimitReachedError(),
  new Domain_InviteNotFoundError(),
  new Domain_InvalidTransitionError(),
  new Domain_UnknownCellError(),
  new Domain_CellUnavailableError(),
  new Domain_ConfirmationMismatchError(),
  new Domain_StaleVersionError(),
].map((e) => ({
  code: e.code,
  status: e.status,
  title: e.title,
  detail: e.message,
  owner: 'tenancy',
}));
