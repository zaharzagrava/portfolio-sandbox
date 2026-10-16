import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';
import type { ImportProblemCode } from '@marketplace-sandbox/contracts';

/**
 * Problem codes of the import routes (S07 contracts/http-api.md). One definition per code; `validation_failed`,
 * `idempotency_*`, `rate_limited`, `shop_suspended` and `shop_offboarding` are platform codes raised by their owners.
 * Another shop's import is `import_not_found` (one body).
 */
type Own = Exclude<
  ImportProblemCode,
  | 'validation_failed'
  | 'idempotency_key_required'
  | 'idempotency_key_invalid'
  | 'idempotency_key_reuse'
  | 'idempotency_in_flight'
  | 'rate_limited'
  | 'shop_suspended'
  | 'shop_offboarding'
>;

const DEFINITIONS: Record<Own, [HttpStatus, string, string]> = {
  import_not_found: [HttpStatus.NOT_FOUND, 'Not found', 'Import not found.'],
  invalid_parts: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Invalid parts',
    'The listed parts do not match the upload. Upload the missing parts and send the exact list.',
  ],
  size_mismatch: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Size mismatch',
    'The uploaded file does not have the declared size. Start the import again.',
  ],
  import_not_uploadable: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The upload of this import is closed.',
  ],
  import_not_completable: [
    HttpStatus.CONFLICT,
    'Conflict',
    'This import can no longer be completed.',
  ],
  import_not_cancellable: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The import has already finished and cannot be cancelled.',
  ],
  import_error_report_not_found: [
    HttpStatus.NOT_FOUND,
    'Not found',
    'This import has no error report.',
  ],
  error_report_not_ready: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The error report is not ready yet.',
  ],
  too_many_active_imports: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The shop already has the maximum number of imports in progress.',
  ],
};

export class ImportProblem extends AppError {
  constructor(
    readonly importCode: Own,
    options: { detail?: string; extensions?: Record<string, unknown> } = {},
  ) {
    const [status, title, detail] = DEFINITIONS[importCode];
    super({
      status,
      code: importCode,
      title,
      detail: options.detail ?? detail,
      area: ErrorArea.DOMAIN,
      extensions: options.extensions,
    });
  }
}

export const importProblem = (code: Own) => new ImportProblem(code);

/** Storage could not be reached: nothing was lost, the caller starts again (`503`, retryable). */
export const importUnavailable = () =>
  new AppError({
    code: 'import_unavailable',
    status: HttpStatus.SERVICE_UNAVAILABLE,
    title: 'Service Unavailable',
    detail: 'The upload service is unavailable. Try again shortly.',
    area: ErrorArea.TRANSIENT,
    retryAfterSeconds: 5,
  });

/** A 400 `validation_failed` naming the fields (never the values). */
export const importValidationFailed = (fields: string[]) =>
  new AppError({
    code: 'validation_failed',
    status: HttpStatus.BAD_REQUEST,
    title: 'Bad Request',
    detail: 'The request is not valid.',
    area: ErrorArea.DOMAIN,
    extensions: { errors: fields.map((field) => ({ field, code: 'invalid' })) },
  });

export const IMPORT_PROBLEMS: ProblemCatalogEntry[] = (
  Object.keys(DEFINITIONS) as Own[]
).map((code) => ({
  code,
  status: DEFINITIONS[code][0],
  title: DEFINITIONS[code][1],
  detail: DEFINITIONS[code][2],
  owner: 'catalog-sync',
}));
