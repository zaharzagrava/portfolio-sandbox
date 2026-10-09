import { trace, context as otelContext, Span } from '@opentelemetry/api';

const tracer = trace.getTracer('payment-service');

/**
 * Universal wrapper to execute any function inside a dedicated Jaeger span (horizontal bar).
 * @param name The name of the bar in Jaeger
 * @param callback Your business logic
 * @param parentSpan (Optional) Only needed if bridging context from another file/system
 */
export async function runInSpan<T>(
  name: string,
  callback: (span: Span) => Promise<T>,
  parentSpan?: Span,
): Promise<T> {
  // If a parent span is provided, strictly link them. Otherwise, grab the active context.
  const ctx = parentSpan
    ? trace.setSpan(otelContext.active(), parentSpan)
    : otelContext.active();

  return await tracer.startActiveSpan(name, {}, ctx, async (span) => {
    try {
      return await callback(span);
    } catch (error: any) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}
