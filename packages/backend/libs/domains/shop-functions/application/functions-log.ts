import type { Logger } from '@nestjs/common';
import { RequestContext } from '@app/infrastructure/context';

/**
 * One structured JSON line (S45 FR-033): an event name, a closed outcome and a correlation id. Never source, test input,
 * a discount message, a token or a cookie.
 */
export function functionsLog(
  logger: Logger,
  context: RequestContext | undefined,
  level: 'log' | 'warn' | 'error',
  event: string,
  fields: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const traceparent = context?.snapshot().traceparent;
  const traceId = traceparent?.split('-')[1];
  logger[level](
    JSON.stringify({
      event,
      requestId: context?.requestId,
      traceId,
      ...fields,
    }),
  );
}
