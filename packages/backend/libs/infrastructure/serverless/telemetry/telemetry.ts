import { AsyncLocalStorage } from 'node:async_hooks';
import { trace } from '@opentelemetry/api';

/**
 * Structured JSON logs + CloudWatch Embedded Metric Format: a metric is a log
 * line with an `_aws` block - no PutMetricData API call (latency, cost,
 * throttling) on the hot path; CloudWatch extracts it asynchronously.
 * Field names follow the platform logger (`level`, `message`, `time`, `traceId`, S54).
 */
export type LogLevel = 'info' | 'warn' | 'error';

const UNITS = new Set([
  'Seconds',
  'Microseconds',
  'Milliseconds',
  'Bytes',
  'Kilobytes',
  'Megabytes',
  'Gigabytes',
  'Terabytes',
  'Bits',
  'Kilobits',
  'Megabits',
  'Gigabits',
  'Terabits',
  'Percent',
  'Count',
  'Bytes/Second',
  'Kilobytes/Second',
  'Megabytes/Second',
  'Gigabytes/Second',
  'Terabytes/Second',
  'Bits/Second',
  'Kilobits/Second',
  'Megabits/Second',
  'Gigabits/Second',
  'Terabits/Second',
  'Count/Second',
  'None',
]);
export const MAX_METRIC_DIMENSIONS = 3;
/** Namespace of the toolkit's own metrics; domain functions keep their business namespaces. */
export const TOOLKIT_NAMESPACE = 'Marketplace/Lambda';

export interface TelemetryOptions {
  /** Where lines go; defaults to the output stream. */
  write?: (line: string) => void;
  /** Epoch milliseconds; defaults to the system clock. Tests freeze it. */
  now?: () => number;
}

const state: Required<TelemetryOptions> = {
  write: (line) => {
    process.stdout.write(line);
  },
  now: () => Date.now(),
};

/** Replace the output and the clock; returns a function that restores the previous ones. */
export function configureTelemetry(options: TelemetryOptions): () => void {
  const previous = { ...state };
  if (options.write) state.write = options.write;
  if (options.now) state.now = options.now;
  return () => Object.assign(state, previous);
}

export function telemetryNow(): number {
  return state.now();
}

export interface InvocationFields {
  traceId?: string;
  messageId?: string;
  [key: string]: unknown;
}
const invocation = new AsyncLocalStorage<InvocationFields>();

/** Fields (trace ID, message ID) that every log line written inside `fn` carries. */
export function withInvocationFields<T>(
  fields: InvocationFields,
  fn: () => T,
): T {
  return invocation.run({ ...invocation.getStore(), ...fields }, fn);
}

function activeTraceId(): string | undefined {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx && ctx.traceId !== '0'.repeat(32) ? ctx.traceId : undefined;
}

export function log(
  level: LogLevel,
  message: string,
  fields: Record<string, unknown> = {},
) {
  const scoped = invocation.getStore() ?? {};
  const traceId = fields.traceId ?? scoped.traceId ?? activeTraceId();
  try {
    state.write(
      `${JSON.stringify({
        level,
        message,
        time: new Date(state.now()).toISOString(),
        ...(traceId !== undefined && { traceId }),
        ...(scoped.messageId !== undefined && { messageId: scoped.messageId }),
        ...fields,
      })}\n`,
    );
  } catch {
    // logging must never fail a record
  }
}

export function metric(
  namespace: string,
  name: string,
  value: number,
  unit: string,
  dimensions: Record<string, string> = {},
) {
  const keys = Object.keys(dimensions);
  const problem =
    keys.length > MAX_METRIC_DIMENSIONS
      ? `more than ${MAX_METRIC_DIMENSIONS} dimensions`
      : !Number.isFinite(value)
        ? 'value is not finite'
        : !UNITS.has(unit)
          ? `unknown unit ${String(unit)}`
          : undefined;
  if (problem) {
    log('warn', 'metric dropped', { metric: name, namespace, reason: problem });
    return;
  }
  try {
    state.write(
      `${JSON.stringify({
        _aws: {
          Timestamp: state.now(),
          CloudWatchMetrics: [
            {
              Namespace: namespace,
              Dimensions: [keys],
              Metrics: [{ Name: name, Unit: unit }],
            },
          ],
        },
        ...dimensions,
        [name]: value,
      })}\n`,
    );
  } catch {
    // a metric must never fail a record
  }
}
