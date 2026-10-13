import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';
import {
  SHORT_LINK_PROBLEM_CODES,
  type ShortLinkProblemCode,
} from '@marketplace-sandbox/contracts';

/**
 * HTTP-visible errors of share links (specs/domains/S37-share-links/contracts/share-links-api.md). Each is an
 * `AppError` with a stable problem `code`; none echoes the destination, the alias, a store name or a stack (FR-012).
 * `validation_failed` and `invalid_cursor` belong to the platform and are raised here with its definition only.
 */
type Params = ConstructorParameters<typeof AppError>[0];

interface Definition {
  status: HttpStatus;
  title: string;
  detail: string;
}

const DEFINITIONS: Record<ShortLinkProblemCode, Definition> = {
  validation_failed: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Bad Request',
    detail: 'The request is not valid.',
  },
  invalid_cursor: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Bad Request',
    detail: 'The cursor is not valid for this list.',
  },
  alias_taken: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'This alias is already taken.',
  },
  alias_reserved: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'This alias is reserved.',
  },
  destination_not_allowed: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'Links may only point to marketplace pages.',
  },
  destination_blocked: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'This destination cannot be shortened.',
  },
  destination_check_unavailable: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    title: 'Service Unavailable',
    detail: 'The destination could not be checked. Retry shortly.',
  },
  link_limit_reached: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'You have reached the number of active links you may hold.',
  },
  link_not_found: {
    status: HttpStatus.NOT_FOUND,
    title: 'Not Found',
    detail: 'There is no such link.',
  },
  link_gone: {
    status: HttpStatus.GONE,
    title: 'Gone',
    detail: 'This link is no longer available.',
  },
  link_not_active: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'The link is disabled or expired and can no longer be changed.',
  },
  code_generation_failed: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    title: 'Service Unavailable',
    detail: 'A link code could not be created. Retry shortly.',
  },
  service_unavailable: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    title: 'Service Unavailable',
    detail: 'Short links are temporarily unavailable. Retry shortly.',
  },
};

export const RETRY_AFTER_SECONDS = 5;

export class ShareLinkError extends AppError {
  constructor(
    readonly linkCode: ShortLinkProblemCode,
    extra: Partial<Params> = {},
  ) {
    const d = DEFINITIONS[linkCode];
    super({
      status: d.status,
      code: linkCode,
      title: d.title,
      detail: d.detail,
      area: ErrorArea.DOMAIN,
      ...extra,
    });
  }
}

/** Thrown by the pure destination policy; carries no part of the offending URL. */
export class DestinationNotAllowedError extends ShareLinkError {
  constructor() {
    super('destination_not_allowed', {
      extensions: {
        errors: [{ field: 'destination', code: 'destination_not_allowed' }],
      },
    });
  }
}

/** The number could not be turned into a code (outside the 40-bit range): a defect or a counter gone wild. */
export class CodeRangeError extends Error {
  constructor() {
    super('id out of 40-bit range');
    this.name = 'CodeRangeError';
  }
}

export const aliasTaken = () => new ShareLinkError('alias_taken');
export const aliasReserved = () =>
  new ShareLinkError('alias_reserved', {
    extensions: { errors: [{ field: 'alias', code: 'alias_reserved' }] },
  });
export const destinationBlocked = () =>
  new ShareLinkError('destination_blocked', {
    extensions: {
      errors: [{ field: 'destination', code: 'destination_blocked' }],
    },
  });
export const destinationCheckUnavailable = () =>
  new ShareLinkError('destination_check_unavailable', {
    retryAfterSeconds: RETRY_AFTER_SECONDS,
  });
export const linkLimitReached = () => new ShareLinkError('link_limit_reached');
export const linkNotFound = () => new ShareLinkError('link_not_found');
export const linkGone = () => new ShareLinkError('link_gone');
export const linkNotActive = () => new ShareLinkError('link_not_active');
export const invalidCursor = () => new ShareLinkError('invalid_cursor');
export const codeGenerationFailed = () =>
  new ShareLinkError('code_generation_failed', {
    retryAfterSeconds: RETRY_AFTER_SECONDS,
  });
export const serviceUnavailable = () =>
  new ShareLinkError('service_unavailable', {
    retryAfterSeconds: RETRY_AFTER_SECONDS,
  });

/** A field-level validation failure: platform `validation_failed` with the offending fields (never their values). */
export const validationFailed = (fields: string[]) =>
  new AppError({
    status: HttpStatus.BAD_REQUEST,
    code: 'validation_failed',
    title: 'Bad Request',
    detail: 'The request is not valid.',
    area: ErrorArea.DOMAIN,
    extensions: {
      errors: fields.map((field) => ({ field, code: 'invalid' })),
    },
  });

/** Codes owned by the platform and not registered again. */
const NOT_OWNED: ShortLinkProblemCode[] = [
  'validation_failed',
  'invalid_cursor',
  // also raised by S25 and S19 with their own wording; whoever registers it first owns the catalog entry
  'service_unavailable',
];

export const SHARE_LINK_PROBLEMS: ProblemCatalogEntry[] =
  SHORT_LINK_PROBLEM_CODES.filter((code) => !NOT_OWNED.includes(code)).map(
    (code) => ({
      code,
      status: DEFINITIONS[code].status,
      title: DEFINITIONS[code].title,
      detail: DEFINITIONS[code].detail,
      owner: 'marketing',
    }),
  );
