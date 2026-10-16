/**
 * Failure classification of an export run (S12 AS-35, FR-021). Pure and closed: an unknown error class is
 * `internal_error` and never retried.
 */
export type ExportFailureCode =
  | 'storage_unavailable'
  | 'catalog_unavailable'
  | 'database_unavailable'
  | 'row_limit_exceeded'
  | 'timeout'
  | 'shop_not_found'
  | 'attempts_exhausted'
  | 'internal_error';

export interface Classification {
  retry: boolean;
  code: ExportFailureCode;
}

/** At most this many deliveries; the failing third one is final. */
export const MAX_EXPORT_DELIVERIES = 3;

const RETRYABLE = new Map<string, ExportFailureCode>([
  ['storage_error', 'storage_unavailable'],
  ['storage_inactivity_timeout', 'storage_unavailable'],
  ['upload_aborted', 'storage_unavailable'],
  ['catalog_timeout', 'catalog_unavailable'],
  ['catalog_error', 'catalog_unavailable'],
  ['order_store_timeout', 'database_unavailable'],
  ['connection_reset', 'database_unavailable'],
  ['deadlock', 'database_unavailable'],
  ['serialization_failure', 'database_unavailable'],
]);

const FINAL = new Map<string, ExportFailureCode>([
  ['row_limit_exceeded', 'row_limit_exceeded'],
  ['deadline_exceeded', 'timeout'],
  ['shop_not_found', 'shop_not_found'],
]);

export function classify(errorClass: string, delivery: number): Classification {
  const retryable = RETRYABLE.get(errorClass);
  if (retryable)
    return { retry: delivery < MAX_EXPORT_DELIVERIES, code: retryable };
  return { retry: false, code: FINAL.get(errorClass) ?? 'internal_error' };
}

const MESSAGES: Readonly<Record<ExportFailureCode, string>> = {
  storage_unavailable: 'The file could not be stored. Start a new export.',
  catalog_unavailable: 'Product details could not be read. Start a new export.',
  database_unavailable: 'Orders could not be read. Start a new export.',
  row_limit_exceeded: 'The export is too large. Contact support.',
  timeout: 'The export took too long. Start a new export.',
  shop_not_found: 'The shop no longer exists.',
  attempts_exhausted: 'The export could not be completed. Start a new export.',
  internal_error: 'The export failed. Start a new export.',
};

/** One fixed generic message per code; never an error text from a collaborator. */
export const failureMessage = (code: ExportFailureCode): string =>
  MESSAGES[code];
