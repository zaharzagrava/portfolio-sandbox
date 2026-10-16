import type { RequestContext } from '@app/infrastructure/context/request-context.service';

/**
 * Appends the correlation id of the current request, message or job to a log line (S04 FR-070, AS-67), in the form the
 * platform's exception filter uses. Lines are fixed text plus identifiers: never a submitted value, an extracted value,
 * a link or a body.
 */
export function correlate(message: string, context?: RequestContext): string {
  const requestId = context?.requestId;
  return requestId ? `${message} [requestId: ${requestId}]` : message;
}
