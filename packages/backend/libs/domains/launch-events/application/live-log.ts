import type { Logger } from '@nestjs/common';

export interface LiveLogFields {
  streamId?: string;
  commentId?: string;
  /** A problem code or a failure class: fixed text, never a value from a request. */
  code?: string;
}

const classOf = (error: unknown): string =>
  error instanceof Error ? error.name : 'UnknownError';

/**
 * One structured line per incident (S23 AS-52): the event name, the stream and the class of the failure. The request
 * id comes from the platform logger's request context. Comment text, e-mail addresses, tokens and `clientId` are never
 * fields here, and the error message (which a store may fill with a value) is not logged either.
 */
export function logLiveWarn(
  logger: Logger,
  event: string,
  fields: LiveLogFields,
  error?: unknown,
): void {
  logger.warn({
    event,
    ...fields,
    ...(error !== undefined && { errorClass: classOf(error) }),
  });
}

export function logLiveError(
  logger: Logger,
  event: string,
  fields: LiveLogFields,
  error?: unknown,
): void {
  logger.error({
    event,
    ...fields,
    ...(error !== undefined && { errorClass: classOf(error) }),
  });
}
