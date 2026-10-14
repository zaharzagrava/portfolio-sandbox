import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';
import {
  FLAG_PROBLEM_CODES,
  type FlagDefinitionErrorCode,
  type FlagProblemCode,
} from '@marketplace-sandbox/contracts';

/**
 * HTTP-visible errors of flags (specs/domains/S38-feature-flags/contracts/flags-api.md). Each is an `AppError` with a
 * stable problem `code`; none echoes a definition body or a store text. `validation_failed` and `payload_too_large`
 * belong to the platform and are raised here with its definition only.
 */
interface Definition {
  status: HttpStatus;
  title: string;
  detail: string;
}

const DEFINITIONS: Record<FlagProblemCode, Definition> = {
  validation_failed: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Bad Request',
    detail: 'The request is not valid.',
  },
  flag_not_found: {
    status: HttpStatus.NOT_FOUND,
    title: 'Not Found',
    detail: 'There is no such flag.',
  },
  version_conflict: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'The flag changed since you read it. Reload and try again.',
  },
  flag_killed: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'The flag is killed and cannot be enabled until it is restored.',
  },
  flag_archived: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'The flag is archived and its key is reserved.',
  },
  invalid_transition: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'The flag is not in a state that allows this change.',
  },
  flag_definition_invalid: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'The flag definition is not valid.',
  },
  flag_limit_reached: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'The maximum number of flags has been reached.',
  },
  invalid_cursor: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Bad Request',
    detail: 'The cursor is not valid for this list.',
  },
  payload_too_large: {
    status: HttpStatus.PAYLOAD_TOO_LARGE,
    title: 'Payload Too Large',
    detail: 'The request body is too large.',
  },
};

export class FlagError extends AppError {
  constructor(
    readonly flagCode: FlagProblemCode,
    extensions: Record<string, unknown> = {},
  ) {
    const d = DEFINITIONS[flagCode];
    super({
      status: d.status,
      code: flagCode,
      title: d.title,
      detail: d.detail,
      area: ErrorArea.DOMAIN,
      ...(Object.keys(extensions).length > 0 && { extensions }),
    });
  }
}

export interface DefinitionProblem {
  path: string;
  code: FlagDefinitionErrorCode;
  /** Present for `weights_sum_invalid`: the actual sum. */
  sum?: number;
}

export const flagNotFound = () => new FlagError('flag_not_found');
export const versionConflict = (currentVersion: number) =>
  new FlagError('version_conflict', { currentVersion });
export const flagKilled = () => new FlagError('flag_killed');
export const flagArchived = () => new FlagError('flag_archived');
export const invalidTransition = (currentStatus: string) =>
  new FlagError('invalid_transition', { currentStatus });
/** `errors[]` carries `path` (the contract of S38) and `field` (the platform's problem schema requires it): same value. */
export const flagDefinitionInvalid = (errors: DefinitionProblem[]) =>
  new FlagError('flag_definition_invalid', {
    errors: errors.map((e) => ({ field: e.path, ...e })),
  });
export const flagLimitReached = () => new FlagError('flag_limit_reached');
export const invalidCursor = () => new FlagError('invalid_cursor');
export const payloadTooLarge = () => new FlagError('payload_too_large');

/** A field-level shape failure: platform `validation_failed` with the offending fields (never their values). */
export const validationFailed = (fields: string[]) =>
  new FlagError('validation_failed', {
    errors: fields.map((field) => ({ field, code: 'invalid' })),
  });

/**
 * Codes owned by the platform, or shared names that S03, S05 and S36 register first with their own wording: not
 * registered again (a second definition with other words would fail startup).
 */
const NOT_OWNED: FlagProblemCode[] = [
  'validation_failed',
  'payload_too_large',
  'invalid_cursor',
  'version_conflict',
  'invalid_transition',
];

export const FLAG_PROBLEMS: ProblemCatalogEntry[] = FLAG_PROBLEM_CODES.filter(
  (code) => !NOT_OWNED.includes(code),
).map((code) => ({
  code,
  status: DEFINITIONS[code].status,
  title: DEFINITIONS[code].title,
  detail: DEFINITIONS[code].detail,
  owner: 'experimentation',
}));
