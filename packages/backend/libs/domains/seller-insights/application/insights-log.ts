import type { Logger } from '@nestjs/common';

/** The trace id of a W3C `traceparent` (`00-<trace-id>-<span-id>-<flags>`), or `undefined`. */
export function traceIdOf(traceparent?: string): string | undefined {
  const parts = traceparent?.split('-');
  return parts && parts.length === 4 && /^[0-9a-f]{32}$/.test(parts[1])
    ? parts[1]
    : undefined;
}

/**
 * One structured JSON line (S40 FR-046, AS-61): the event name, identifiers of orders, periods and shops, and a
 * correlation id (`traceId`, or `requestId` for a request). Never a buyer id, an e-mail or a payload body.
 */
export function insightsLog(
  logger: Logger,
  level: 'log' | 'warn' | 'error',
  event: string,
  correlation: { traceId?: string; requestId?: string },
  fields: Record<string, string | number | boolean | null | undefined> = {},
): void {
  logger[level](JSON.stringify({ event, ...correlation, ...fields }));
}
