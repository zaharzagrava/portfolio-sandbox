import {
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
} from '@opentelemetry/api';

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** The W3C `traceparent` message attribute as a remote parent span context, or undefined when absent or malformed. */
export function parseTraceparent(value: string | undefined) {
  const match = value ? TRACEPARENT.exec(value) : null;
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2]))
    return undefined;
  return {
    traceId: match[1],
    spanId: match[2],
    traceFlags: parseInt(match[3], 16),
    isRemote: true,
  };
}

/**
 * Run `fn` inside a consumer span whose parent is the producer's span (S55 AS-50). The span's trace ID is passed to
 * `fn` so log lines of the invocation can carry it even when no tracing SDK is registered (a no-op span still keeps
 * the parent's trace ID).
 */
export function withConsumerSpan<T>(
  name: string,
  traceparent: string | undefined,
  fn: (span: Span, traceId: string | undefined) => Promise<T>,
): Promise<T> {
  const parent = parseTraceparent(traceparent);
  const base = parent
    ? trace.setSpanContext(context.active(), parent)
    : context.active();
  return trace
    .getTracer('marketplace-serverless')
    .startActiveSpan(name, { kind: SpanKind.CONSUMER }, base, async (span) => {
      try {
        const traceId = span.spanContext().traceId;
        return await fn(span, /^0+$/.test(traceId) ? undefined : traceId);
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
}
