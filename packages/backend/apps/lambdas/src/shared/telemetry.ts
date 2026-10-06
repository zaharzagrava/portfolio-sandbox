/**
 * Structured JSON logs + CloudWatch Embedded Metric Format: a metric is a log
 * line with an `_aws` block - no PutMetricData API call (latency, cost,
 * throttling) on the hot path; CloudWatch extracts it asynchronously.
 */
export function log(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ level, message, time: new Date().toISOString(), ...fields })}\n`);
}

export function metric(namespace: string, name: string, value: number, unit: 'Count' | 'Milliseconds', dimensions: Record<string, string> = {}) {
  process.stdout.write(
    `${JSON.stringify({
      _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [Object.keys(dimensions)], Metrics: [{ Name: name, Unit: unit }] }] },
      ...dimensions,
      [name]: value,
    })}\n`,
  );
}
