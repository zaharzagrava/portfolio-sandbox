import { SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * One span around an export run (S12 FR-037): the log lines written inside it carry its trace id. Attributes are ids
 * and counts only, never a title, SKU, amount, link or storage location. The tracer is looked up per call so a spec
 * can observe it.
 */
export function exportSpan<T>(
  name: string,
  attributes: Record<string, string | number>,
  fn: () => Promise<T>,
): Promise<T> {
  return trace
    .getTracer('order-exports')
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
