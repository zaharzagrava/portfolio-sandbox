/**
 * OpenTelemetry bootstrap (SD-33). Each app has an `instrument.ts` that calls
 * `startTelemetry('<service>')` and is the FIRST import of its main.ts -
 * instrumentation must patch http/pg/ioredis/kafkajs before they are
 * required (a call inside main() would run after main's own imports).
 *
 *  - traces: OTLP/HTTP → OTel Collector (tail sampling, PII scrubbing there),
 *  - metrics: Prometheus pull endpoint on a SEPARATE port (:9464/metrics,
 *    never routed through the public ALB),
 *  - cardinality discipline in code: views keep an allowlist of attributes
 *    per instrument and cap series per metric (no userId/shopId labels, ever),
 *  - stable HTTP semconv → `http_server_request_duration_seconds` with route
 *    templates (never raw URLs) as the SLI source for SLO rules.
 *
 * Config is standard OTel env (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SDK_DISABLED);
 * METRICS_PORT overrides the per-service default below.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import {
  AggregationType,
  createAllowListAttributesProcessor,
  ViewOptions,
} from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import type { IncomingMessage } from 'node:http';
import { isExemptPath } from '@app/common/logging/exempt-paths';
import { setTelemetryFlush } from './telemetry-flush';
import { unmatchedRouteProcessor } from './route-label';

process.env.OTEL_SEMCONV_STABILITY_OPT_IN ??= 'http';

/** Seconds; dense where SLO thresholds live (100-500 ms), sparse in the tail. */
const HTTP_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 2.5, 5, 10,
];

/** Every metric gets a series ceiling; going over is a bug (someone added a high-cardinality label), and it shows as an overflow series. */
const CARDINALITY_LIMIT = 2_000;

export const METRIC_VIEWS: ViewOptions[] = [
  {
    instrumentName: 'http.server.request.duration',
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: { boundaries: HTTP_BUCKETS },
    },
    attributesProcessors: [
      createAllowListAttributesProcessor([
        'http.request.method',
        'http.route',
        'http.response.status_code',
        'error.type',
      ]),
      unmatchedRouteProcessor,
    ],
    aggregationCardinalityLimit: CARDINALITY_LIMIT,
  },
  {
    instrumentName: 'http.client.request.duration',
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: { boundaries: HTTP_BUCKETS },
    },
    // server.address only: full URLs (ids in paths) would explode the series count.
    attributesProcessors: [
      createAllowListAttributesProcessor([
        'http.request.method',
        'server.address',
        'http.response.status_code',
        'error.type',
      ]),
    ],
    aggregationCardinalityLimit: CARDINALITY_LIMIT,
  },
  {
    instrumentName: 'db.client.*',
    attributesProcessors: [
      createAllowListAttributesProcessor([
        'db.system.name',
        'db.operation.name',
        'db.client.connection.state',
        'db.client.connection.pool.name',
        'error.type',
      ]),
    ],
    aggregationCardinalityLimit: CARDINALITY_LIMIT,
  },
  { instrumentName: '*', aggregationCardinalityLimit: CARDINALITY_LIMIT },
];

/** Distinct ports so every app can run side by side on one dev machine; Prometheus scrapes these (infra/observability). */
export const SERVICE_METRICS_PORTS = {
  core: 9464,
  worker: 9465,
  projector: 9466,
  'sse-gateway': 9467,
  'payment-processor': 9468,
  collab: 9469,
  'public-api': 9470,
  bff: 9471,
} as const;

export type ServiceName = keyof typeof SERVICE_METRICS_PORTS;

let started = false;

export function startTelemetry(service: ServiceName): void {
  // Also read by the logger (every JSON line carries `service`, the Loki label).
  process.env.OTEL_SERVICE_NAME ??= service;
  if (
    started ||
    process.env.OTEL_SDK_DISABLED === 'true' ||
    process.env.NODE_ENV === 'test'
  )
    return;
  started = true;
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: service,
      [ATTR_SERVICE_VERSION]: process.env.APP_VERSION ?? 'dev',
      'deployment.environment.name': process.env.NODE_ENV ?? 'local',
    }),
    traceExporter: new OTLPTraceExporter(), // OTEL_EXPORTER_OTLP_ENDPOINT, default http://localhost:4318
    metricReaders: [
      new PrometheusExporter({
        port: Number(
          process.env.METRICS_PORT ?? SERVICE_METRICS_PORTS[service],
        ),
        endpoint: '/metrics',
      }),
    ],
    views: METRIC_VIEWS,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Noise / cost without insight.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (req: IncomingMessage) =>
            isExemptPath(req.url ?? ''),
          // Never record query strings, cookies or auth headers on spans.
          headersToSpanAttributes: {
            server: { requestHeaders: ['x-request-id'] },
          },
        },
        '@opentelemetry/instrumentation-pg': {
          enhancedDatabaseReporting: false,
        },
        // Event-loop delay/utilization, GC, heap - the Node USE metrics.
        '@opentelemetry/instrumentation-runtime-node': { enabled: true },
      }),
    ],
  });
  sdk.start();

  // The shutdown sequence flushes at order 95 (after every other task); no signal handler of our own, so exactly one
  // owner of process signals exists (S54 FR-047). `beforeExit` covers a process that ends without that sequence.
  let flushed: Promise<void> | undefined;
  const flush = () => (flushed ??= sdk.shutdown().catch(() => undefined));
  setTelemetryFlush(flush);
  process.once('beforeExit', () => void flush());
}
