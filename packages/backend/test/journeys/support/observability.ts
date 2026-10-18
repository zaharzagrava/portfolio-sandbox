import { existsSync, readFileSync, statSync } from 'node:fs';

/** The Prometheus pull endpoint of the process that serves the API (`SERVICE_METRICS_PORTS.core`); override with `METRICS_URL`. */
export const METRICS_URL =
  process.env.METRICS_URL ?? 'http://localhost:9464/metrics';

export type MetricSnapshot = Map<string, number>;

/** One sample per `name{labels}` line, keyed by the name and the sorted labels without the scope label. */
export async function readMetrics(): Promise<MetricSnapshot> {
  const response = await fetch(METRICS_URL).catch((error: Error) => {
    throw new Error(
      `BLOCKED: the metrics endpoint ${METRICS_URL} is not reachable (${error.message}); set METRICS_URL`,
    );
  });
  if (!response.ok)
    throw new Error(`BLOCKED: ${METRICS_URL} answered ${response.status}`);
  const snapshot: MetricSnapshot = new Map();
  for (const line of (await response.text()).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match =
      /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(-?[0-9.eE+-]+|NaN|\+Inf)$/.exec(
        line,
      );
    if (!match) continue;
    const labels = [
      ...(match[2] ?? '').matchAll(
        /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g,
      ),
    ]
      .filter(([, key]) => key !== 'otel_scope_name')
      .map(([, key, value]) => `${key}=${value}`)
      .sort();
    snapshot.set(`${match[1]}{${labels.join(',')}}`, Number(match[3]));
  }
  return snapshot;
}

/** The value of `name` with at least the given labels (summed over the other labels); 0 when the series does not exist yet. */
export function metricValue(
  snapshot: MetricSnapshot,
  name: string,
  labels: Record<string, string> = {},
): number {
  const wanted = Object.entries(labels).map(
    ([key, value]) => `${key}=${value}`,
  );
  let total = 0;
  for (const [key, value] of snapshot) {
    if (!key.startsWith(`${name}{`)) continue;
    const present = key.slice(name.length + 1, -1).split(',');
    if (wanted.every((label) => present.includes(label))) total += value;
  }
  return total;
}

/** The API log the stack writes (the runner sets `API_LOG`); null when this run has no access to one. */
export function apiLogPath(): string | null {
  const path = process.env.JOURNEY_API_LOG ?? process.env.API_LOG;
  return path && existsSync(path) ? path : null;
}

/** The size of the log now, so a later read sees only the lines of this run. */
export const logMark = (path: string | null): number =>
  path ? statSync(path).size : 0;

export function logLinesSince(path: string, mark: number): string[] {
  const bytes = readFileSync(path);
  // A log that is now shorter than the mark was truncated or recreated (the runner restarts the API): every line in it is newer than the mark.
  return bytes
    .subarray(bytes.length < mark ? 0 : mark)
    .toString('utf8')
    .split('\n')
    .filter(Boolean);
}
