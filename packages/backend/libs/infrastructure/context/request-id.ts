import { v7 as uuidv7 } from 'uuid';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

export const isValidRequestId = (value: unknown): value is string =>
  typeof value === 'string' && REQUEST_ID_PATTERN.test(value);

/** A well-formed single inbound id is kept so one id follows a request across services; anything else is replaced. */
export const resolveRequestId = (
  headerValue: string | string[] | undefined,
): string => (isValidRequestId(headerValue) ? headerValue : uuidv7());
