import { SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * One span around a step of the flash-sale path (S11 AS-42): admission, reserve, release and each job. Attributes are
 * ids and counts only, never a buyer's e-mail or a token. The tracer is looked up per call, so a spec can observe it.
 */
export function flashSpan<T>(
  name: string,
  attributes: Record<string, string | number>,
  fn: () => Promise<T>,
): Promise<T> {
  return trace
    .getTracer('flash-sales')
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
