import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';

/**
 * HTTP-visible errors of the seller discount functions (specs/domains/S45-discount-functions/contracts/api.md, FR-034).
 * Each is an `AppError` with a stable problem `code` that the global problem+json filter renders; none carries source,
 * test input, a discount message, SQL or engine text. `validation_failed` and `rate_limited` are the platform's,
 * `entitlement_required` billing's, `forbidden` and `unauthenticated` tenancy's and identity's.
 */
type Params = ConstructorParameters<typeof AppError>[0];

export const SHOP_FUNCTION_OWNED_ERROR_CODES = [
  'invalid_cursor',
  'invalid_test_case',
  'function_not_found',
  'version_not_found',
  'function_name_taken',
  'function_limit_reached',
  'version_limit_reached',
  'function_state_conflict',
  'version_not_activatable',
] as const;
export type ShopFunctionOwnedErrorCode =
  (typeof SHOP_FUNCTION_OWNED_ERROR_CODES)[number];

const DEFINITIONS: Record<
  ShopFunctionOwnedErrorCode,
  { status: HttpStatus; title: string; detail: string }
> = {
  invalid_cursor: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Bad Request',
    detail: 'The cursor is not valid.',
  },
  invalid_test_case: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'A test case is not valid.',
  },
  function_not_found: {
    status: HttpStatus.NOT_FOUND,
    title: 'Not Found',
    detail: 'Function not found.',
  },
  // the same definition as content's and asset-library's, so the shared catalog accepts all three owners
  version_not_found: {
    status: HttpStatus.NOT_FOUND,
    title: 'Not found',
    detail: 'Version not found.',
  },
  function_name_taken: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'A function with this name already exists.',
  },
  function_limit_reached: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'The shop has reached its limit of functions.',
  },
  version_limit_reached: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'The function has reached its limit of versions.',
  },
  function_state_conflict: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'The function is already in that state.',
  },
  version_not_activatable: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'This version cannot be activated.',
  },
};

export class ShopFunctionError extends AppError {
  constructor(
    readonly functionCode: ShopFunctionOwnedErrorCode,
    extra: Partial<Params> = {},
  ) {
    const d = DEFINITIONS[functionCode];
    super({
      status: d.status,
      code: functionCode,
      title: d.title,
      detail: d.detail,
      area: ErrorArea.DOMAIN,
      ...extra,
    });
  }
}

/**
 * `invalid_cursor` belongs to the platform and is raised here with its wording only. `version_limit_reached` is 422
 * here (FR-034) while asset-library's catalog entry of the same name is 409: the shared catalog cannot hold both, so
 * this capability raises it without registering it (gaps.md, Sibling-spec follow-ups).
 */
const NOT_REGISTERED: ShopFunctionOwnedErrorCode[] = [
  'invalid_cursor',
  'version_limit_reached',
];
export const SHOP_FUNCTION_PROBLEMS: ProblemCatalogEntry[] =
  SHOP_FUNCTION_OWNED_ERROR_CODES.filter(
    (code) => !NOT_REGISTERED.includes(code),
  ).map((code) => ({
    code,
    status: DEFINITIONS[code].status,
    title: DEFINITIONS[code].title,
    detail: DEFINITIONS[code].detail,
    owner: 'shop-functions',
  }));

export const invalidCursor = () => new ShopFunctionError('invalid_cursor');
/** Names the case and the field (never a value): the seller wrote both, and the response is theirs. */
export const invalidTestCase = (testName: string, field: string) =>
  new ShopFunctionError('invalid_test_case', {
    detail: `Test case "${testName.slice(0, 80)}" is not valid: ${field}.`,
    extensions: { test: testName.slice(0, 80), field },
  });
export const functionNotFound = () =>
  new ShopFunctionError('function_not_found');
export const versionNotFound = () => new ShopFunctionError('version_not_found');
export const functionNameTaken = () =>
  new ShopFunctionError('function_name_taken');
export const functionLimitReached = (limit: number) =>
  new ShopFunctionError('function_limit_reached', { extensions: { limit } });
export const versionLimitReached = (limit: number) =>
  new ShopFunctionError('version_limit_reached', { extensions: { limit } });
export const functionStateConflict = () =>
  new ShopFunctionError('function_state_conflict');
export const versionNotActivatable = () =>
  new ShopFunctionError('version_not_activatable');

/** A field-level validation failure: platform `validation_failed` with the offending fields (never their values). */
export const functionValidationFailed = (fields: string[]) =>
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

/** A conditional update changed no row: another request moved the state first. Programmer-facing, never HTTP. */
export class StaleStateError extends Error {
  constructor(what: string) {
    super(`stale state: ${what}`);
    this.name = 'StaleStateError';
  }
}
