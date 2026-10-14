import { SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * One span around a step of the auction path (S21 AS-51): a bid, a close, an order request. Attributes are ids and
 * counts only, never a bidder's e-mail, token or maximum. The tracer is looked up per call, so a spec can observe it.
 */
export function auctionSpan<T>(
  name: string,
  attributes: Record<string, string | number>,
  fn: () => Promise<T>,
): Promise<T> {
  return trace
    .getTracer('auctions')
    .startActiveSpan(name, { attributes }, async (span) => {
      try {
        return await fn();
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
}
