import { ApiError } from './errors';

/** `Idempotency-Key` and the batch operations' `idempotencyKey`: 1 to 255 printable ASCII characters (FR-049). */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

/** `If-Match: "7"` → 7. Absent → `428 precondition_required`; anything that is not a version → `400` (FR-040). */
export function parseIfMatch(header: string | undefined): number {
  if (header === undefined || header.trim() === '')
    throw new ApiError(
      'precondition_required',
      'If-Match with the product version is required.',
    );
  const m = /^(?:W\/)?"?(\d{1,9})"?$/.exec(header.trim());
  if (!m || Number(m[1]) < 1)
    throw new ApiError(
      'validation_failed',
      'If-Match must carry a product version.',
      {
        errors: [{ field: 'If-Match', code: 'invalid' }],
      },
    );
  return Number(m[1]);
}
