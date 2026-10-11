import type { ZodType } from 'zod';

/**
 * Parses a response body with its contracts schema. A body that does not match is a failed call with status 500 and the
 * code `invalid_response`, in the same shape `problemFromError` reads from an axios error.
 */
export class ApiParseError extends Error {
  readonly response = { status: 500, data: { code: 'invalid_response' }, headers: {} };
  constructor() {
    super('invalid_response');
    this.name = 'ApiParseError';
  }
}

export function parseBody<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new ApiParseError();
  return result.data;
}
