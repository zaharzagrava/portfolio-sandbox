# Observability: Logs, Metrics, Traces (OpenTelemetry) for Node.js

---

## 1. Monitoring vs observability

- **Monitoring**: checks for *known* failure modes (dashboards and alerts on predefined metrics).
- **Observability**: being able to ask *new* questions about system behavior from its outputs without shipping new code. You need high-cardinality, correlated telemetry for that.
- The signals: **metrics**, **logs**, **traces**, plus **profiles** (continuous profiling) and **events** (deploys, flag changes). eBPF tools (Groundcover, Pixie, Cilium Hubble) collect some of this without code changes.

---

## 2. Metrics

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`METRIC_VIEWS`](../../packages/backend/libs/common/telemetry/telemetry.ts#L37): METRIC_VIEWS applies per-instrument cardinality limits and attribute allowlists to the project's metrics. _(telemetry.ts)_ · [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md)
> - [`SERVICE_METRICS_PORTS`](../../packages/backend/libs/common/telemetry/telemetry.ts#L60): SERVICE_METRICS_PORTS gives each service its own Prometheus pull port. _(telemetry.ts)_ · [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md)
<!-- theory-links:end -->

### Types (Prometheus model)
| Type | What | Example | Query pattern |
|---|---|---|---|
| Counter | monotonically increasing | `http_requests_total` | `rate(x[5m])` |
| Gauge | value up/down | `db_pool_in_use`, `queue_depth` | direct, `avg_over_time` |
| Histogram | bucketed observations, aggregatable | `http_request_duration_seconds_bucket` | `histogram_quantile(0.99, sum by (le)(rate(..._bucket[5m])))` |
| Summary | client-side quantiles | — | **not aggregatable across pods** → prefer histograms |

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`QueueMetricsService`](../../packages/backend/libs/infrastructure/sqs/queue-metrics.service.ts#L15): QueueMetricsService exports SQS queue depth and message age as OpenTelemetry gauges. _(queue-metrics.service.ts)_
> - [`EventLoopMonitor`](../../packages/backend/libs/common/load-shedding/event-loop-monitor.service.ts#L12): EventLoopMonitor publishes the event-loop delay p99 as a metric. _(event-loop-monitor.service.ts)_ · [load-shedding](../../docs/humans/concepts/common-load-shedding/load-shedding.md)
<!-- theory-links:end -->

### Methods
- **RED** (for services): **R**ate, **E**rrors, **D**uration, per endpoint.
- **USE** (for resources): **U**tilization, **S**aturation, **E**rrors. For a DB pool: in-use / max, wait queue length, acquire timeouts.
- **Four Golden Signals** (Google SRE): latency, traffic, errors, saturation.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`errorRatio`](../../packages/backend/libs/common/telemetry/slo-rules.ts#L43): errorRatio builds PromQL error-ratio expressions for availability (5xx) and latency (histogram bucket) SLIs, which is the RED errors and duration side. _(slo-rules.ts)_ · [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md)
> - [`SloDefinition`](../../packages/backend/libs/common/telemetry/slo-rules.ts#L12): SloDefinition defines the SLOs, with SLI type, metric and objective, that the RED and golden-signal alerts are based on. _(slo-rules.ts)_ · [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md)
> - [`QueueMetricsService`](../../packages/backend/libs/infrastructure/sqs/queue-metrics.service.ts#L15): QueueMetricsService reports queue depth and message age, which are USE-style saturation signals. _(queue-metrics.service.ts)_
<!-- theory-links:end -->

### Pitfalls
- **Cardinality explosion**: labels such as `userId`, `requestId`, raw URL paths (`/users/123`), or email turn one metric into millions of time series and blow up Prometheus memory and cost. Use **route templates** (`/users/:id`) and bounded label values.
- **Averages hide problems**. Use percentiles from histograms. **Percentiles can't be averaged** across pods or time; aggregate the buckets, then compute the quantile.
- Choose histogram buckets around your SLO thresholds (e.g. a 0.3 s bucket for a 300 ms SLO).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`METRIC_VIEWS`](../../packages/backend/libs/common/telemetry/telemetry.ts#L37): METRIC_VIEWS caps the number of attribute combinations per instrument and allowlists attributes, which guards against cardinality explosion. _(telemetry.ts)_ · [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md)
<!-- theory-links:end -->

### Node-specific metrics worth exporting
`prom-client` `collectDefaultMetrics()` gives you: event loop lag, GC duration by kind, heap per space, active handles, and RSS. Add your own:
- `db_pool_waiting_clients`, `db_pool_acquire_duration_seconds`
- `outbound_http_duration_seconds{target}`, `circuit_breaker_state{dep}`
- Business metrics: `orders_placed_total`, `invoice_generation_failures_total`, `ab_exposure_events_total{experiment}`.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`EventLoopMonitor`](../../packages/backend/libs/common/load-shedding/event-loop-monitor.service.ts#L12): EventLoopMonitor exports event-loop delay p99 as a Node-specific runtime metric. _(event-loop-monitor.service.ts)_ · [load-shedding](../../docs/humans/concepts/common-load-shedding/load-shedding.md)
> - [`QueueMetricsService`](../../packages/backend/libs/infrastructure/sqs/queue-metrics.service.ts#L15): QueueMetricsService adds custom queue depth and message-age gauges. _(queue-metrics.service.ts)_
> - [`startTelemetry`](../../packages/backend/libs/common/telemetry/telemetry.ts#L75): startTelemetry sets up the OTel metrics pipeline and the Prometheus pull endpoint. _(telemetry.ts)_ · [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md)
<!-- theory-links:end -->

---

## 3. Logs

### Structured logging with pino
```ts
import pino from 'pino';
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.iban', '*.token'], censor: '[REDACTED]' },
  mixin: () => {                                // inject request context from AsyncLocalStorage
    const store = als.getStore();
    const span = trace.getActiveSpan()?.spanContext();
    return { requestId: store?.requestId, userId: store?.userId, traceId: span?.traceId, spanId: span?.spanId };
  },
});
logger.info({ invoiceId, amountCents }, 'invoice generated');   // fields, not string concatenation
```
- **JSON lines to stdout**. The platform (Fluent Bit, Vector, OTel Collector) ships them. The app shouldn't write files or talk to log backends synchronously.
- **Levels**: `error` = needs attention, `warn` = unexpected but handled, `info` = business events and lifecycle, `debug` = off in production (enable dynamically).
- **Correlation**: requestId/traceId on every line, so you can jump from logs to traces and back.
- **Don't log**: secrets, tokens, full card or bank numbers, passwords, or excessive PII (GDPR).
- Volume and cost: sample high-volume success logs; keep all errors. Prefer one "canonical log line" per request (wide event with all the context) over 20 small lines.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`LoggingModule`](../../packages/backend/libs/common/logging/logging.module.ts#L99): LoggingModule is a global NestJS module that configures pino JSON logging to stdout with OTel trace correlation and PII redaction. _(logging.module.ts)_ · [logging](../../docs/humans/concepts/common-logging/logging.md)
> - [`log`](../../packages/backend/apps/lambdas/src/shared/telemetry.ts#L6): The lambdas' log helper writes structured JSON log lines with level, timestamp and custom fields. _(telemetry.ts)_
<!-- theory-links:end -->

---

## 4. Distributed tracing

- **Trace** = the tree of **spans** for one request across services. A span has a name, start and end, attributes, status, events, and a parent.
- **Context propagation**: the W3C `traceparent` header (`00-<traceId>-<spanId>-<flags>`) plus `tracestate`/`baggage`.
- **Across queues**: put `traceparent` in **message attributes** (SQS MessageAttributes, Kafka headers). The consumer creates a span **linked** to the producer's span (span links, since it's async).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`KafkaConsumerService`](../../packages/backend/libs/infrastructure/kafka/kafka-consumer.service.ts#L32): KafkaConsumerService processes messages with distributed tracing, picking up the trace context from the message. _(kafka-consumer.service.ts)_
> - [`runInSpan`](../../packages/backend/libs/domains/payments/infra/tracing.utils.ts#L11): runInSpan wraps payment operations in a named span with optional parent linking. _(tracing.utils.ts)_ · [Charging a card through Stripe](../../docs/humans/concepts/domain-payments/charging-a-payment.md)
> - [`Init`](../../packages/payments/internal/tracing/tracing.go#L24): The Go payments service's Init installs the global tracer provider and the W3C propagator. _(tracing.go)_
<!-- theory-links:end -->

### OpenTelemetry in Node
```ts
// tracing.ts — must load BEFORE app code so instrumentations can patch modules
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const sdk = new NodeSDK({
  serviceName: 'checkout-api',
  traceExporter: new OTLPTraceExporter({ url: 'http://otel-collector:4318/v1/traces' }),
  instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
});
sdk.start();
// run with: node --import ./tracing.js dist/main.js   (ESM)   or  -r ./tracing.js (CJS)
```
Auto-instrumentation covers http, express/nest/fastify, pg, ioredis, aws-sdk, kafkajs, and more. Add **manual spans** around business operations:
```ts
await tracer.startActiveSpan('invoice.generate', async (span) => {
  span.setAttributes({ 'invoice.client_id': clientId, 'invoice.period': period });
  try { return await generate(); }
  catch (e) { span.recordException(e as Error); span.setStatus({ code: SpanStatusCode.ERROR }); throw e; }
  finally { span.end(); }
});
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`startTelemetry`](../../packages/backend/libs/common/telemetry/telemetry.ts#L75): startTelemetry bootstraps the OpenTelemetry SDK with the service name and trace and metric endpoints. _(telemetry.ts)_ · [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md)
> - [`runInSpan`](../../packages/backend/libs/domains/payments/infra/tracing.utils.ts#L11): runInSpan adds a manual span around business operations. _(tracing.utils.ts)_ · [Charging a card through Stripe](../../docs/humans/concepts/domain-payments/charging-a-payment.md)
> - [`src/instrument.ts`](../../packages/backend/apps/core/src/instrument.ts): The core app's instrument.ts initializes telemetry before any application code loads.
<!-- theory-links:end -->

### Sampling
- **Head sampling** (decided at trace start, e.g. 10%): cheap, but it can drop the interesting traces.
- **Tail sampling** (in the OTel Collector, after the trace completes): keep **all errors and slow traces** plus a percentage of the rest. Costs more because the collector buffers whole traces.
- Use **exemplars** to link a metric data point (a latency spike in a histogram) to a specific trace ID.

---

## 5. OpenTelemetry Collector architecture

```
apps (OTLP) ──► OTel Collector (agent/daemonset or gateway)
                 receivers → processors (batch, memory_limiter, tail_sampling, attributes/redaction, k8sattributes)
                 → exporters (Prometheus/Mimir, Tempo/Jaeger, Loki/Elastic, Datadog, ...)
```
It's vendor-neutral: switching backends doesn't change app code.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`startTelemetry`](../../packages/backend/libs/common/telemetry/telemetry.ts#L75): startTelemetry sends traces and metrics to the configured OTLP endpoints, so the app is backend-neutral. _(telemetry.ts)_ · [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md)
<!-- theory-links:end -->

---

## 6. Dashboards that work

- Top row: **SLO status and error budget remaining**, request rate, error rate, latency percentiles (RED).
- Then dependencies: DB (latency, connections, pool waits), Redis, external APIs (latency and error rate per dependency), queues (depth and age).
- Then resources: CPU (including throttling), memory against limit, event loop delay, GC, pod restarts.
- **Deploy markers** (annotations) on every graph. The first question in an incident is "what changed?"
- One dashboard per service with a consistent layout across services.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`sloRuleGroup`](../../packages/backend/libs/common/telemetry/slo-rules.ts#L55): sloRuleGroup generates the Prometheus recording and multi-burn-rate alert rules that drive the SLO and error-budget view. _(slo-rules.ts)_ · [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md)
> - [`BURN_ALERTS`](../../packages/backend/libs/common/telemetry/slo-rules.ts#L30): BURN_ALERTS defines the page and ticket multi-window burn-rate alert patterns. _(slo-rules.ts)_ · [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md)
<!-- theory-links:end -->

---

## 7. Debugging with telemetry: an example walkthrough

> "p99 latency for /orders/:id went from 300ms to 2s."
1. The RED dashboard shows it started at 14:05, which matches the deploy annotation.
2. An exemplar or slow trace shows a `pg.query` span of 1.7 s: `SELECT ... FROM order_items WHERE order_id = $1 ORDER BY ...`.
3. `pg_stat_statements` confirms mean time jumped. `EXPLAIN` shows a Seq Scan, because the new deploy added an `ORDER BY` column that isn't in the index.
4. Mitigate: roll back. Fix: a composite index created concurrently. Prevent: an EXPLAIN check in CI on the critical queries, or a canary with latency analysis.

---

## Interview Q&A

**Q: What would you instrument in a new Node service?**
RED metrics per route template, histograms with buckets around the SLO thresholds, runtime metrics (event loop delay, heap, GC), pool and queue saturation, business KPIs, structured JSON logs with trace and request IDs plus redaction, OTel auto-instrumentation plus manual spans for key business operations, context propagated across queues, and tail sampling that keeps errors and slow traces.

**Q: Why not put userId as a Prometheus label?**
Unbounded cardinality: every unique value creates a time series, which blows up memory and cost. Per-user analysis belongs in logs or traces (high-cardinality stores), or in an analytics pipeline.
