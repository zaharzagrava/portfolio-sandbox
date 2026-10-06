# SD-33 — Observability Platform (metrics, logs, traces, alerting)

Status: ☑ done (configs + code written; nothing started) · Phase 8 · Depends on: F-01 · Extends README #2 (k6 × OTEL)

## Marketplace adaptation
Not building a TSDB — building the **observability stack** the marketplace runs on: OTel Collector pipeline, Prometheus metrics, Loki logs, Jaeger/Tempo traces, Grafana dashboards, Alertmanager rules with **SLO burn-rate alerts**.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| OTel SDK in all apps (exists in core) → **OTel Collector** (batch, memory limiter, attributes processor redacting PII, **tail sampling**: keep errors + slow traces + 5% of rest) → Jaeger/Tempo | 07/02 §4–5 |
| RED metrics per route (histograms with sane buckets), USE for pools; Node metrics: event-loop lag, GC, heap, active handles; Kafka consumer lag, SQS age, DB pool waiters | 07/02 §2 |
| **Cardinality discipline**: no userId/shopId labels; exemplars link metrics → traces | 07/02 §2, 10/09 #33 |
| Logs: pino JSON → stdout → collector/Promtail → **Loki** (labels only: service, level, env) | 07/02 §3, 10/09 #33 |
| **Multi-window multi-burn-rate alerts** (14.4× 1h/5m page, 6× 6h/30m page, 1× 3d/6h ticket) as Prometheus rules generated from SLO definitions | 07/01 §5.1 |
| Cause-based alerts (DB connections, DLQ not empty, consumer lag) with thresholds from the notes | 07/01 §5.2 |
| Dashboards as code (Grafana JSON provisioning) | 07/02 §6 |
| AWS mapping: ADOT → CloudWatch / X-Ray / AMP (Terraform O-03) | 08/03 §6 |

## Steps
- [x] docker-compose: otel-collector, prometheus, alertmanager, loki, **alloy** (Q73), grafana (provisioned datasources + dashboards), postgres/redis/kafka exporters; Jaeger kept.
- [x] `infra/observability/` configs: collector pipeline, prometheus scrape + rules, alertmanager routes, grafana dashboards (API RED, async pipelines, flash sale, payments, LLM).
- [x] OTel SDK bootstrap in every app with a Prometheus endpoint per app (OTel Prometheus exporter, not prom-client - Q74).
- [x] SLO → rules generator (`pnpm slo:generate`, `scripts/slo/generate.ts` + pure `slo-rules.ts`, unit-tested).

## Scale
- Target: telemetry for ~200 instances at D25 load: ~2M active series (cardinality budget per service enforced), 50k spans/s before tail sampling (~5k/s after), 100k log lines/s.
- Bottleneck & fix: series explosion → label allowlist in collector; trace volume → tail sampling; log cost → drop debug at source, Loki label-only index.

## Implementation notes (2026-10-02)
- **Bootstrap:** `libs/common/src/telemetry/telemetry.ts` provides `startTelemetry(service)`, called from each app's `instrument.ts`, which is the first import of `main.ts`. In compiled CommonJS, a call inside `main()` would run after main's own requires, too late to patch modules.
  - Traces: OTLP/HTTP → collector.
  - Metrics: Prometheus endpoint on a per-service port (9464-9471, `SERVICE_METRICS_PORTS`), never on the public port.
  - Stable HTTP semconv, so the SLI is `http_server_request_duration_seconds` with route templates.
  - Runtime-node metrics on; fs/dns/net instrumentation off.
  - The old `apps/core/src/tracing.ts` was dead code (never imported, wrong service name) and is removed.
- **Cardinality discipline in code:** metric views keep an attribute allowlist per instrument (method, route, status; client calls by `server.address`, never URLs) and cap every metric at 2000 series.
- **Logs:** pino `level` is emitted as a string, and every line carries `service` + `traceId`. `LOG_FILE=./logs/<app>.log` writes JSON to stdout and the file (`pino.multistream`) for host-run apps.
  - Alloy ships Docker stdout and those files to Loki with labels `service`, `level`, `env` only. `traceId` is structured metadata, linked to Jaeger in Grafana (and back from spans to logs).
- **Collector** (`otel-collector.yaml`): `memory_limiter` → scrub PII attributes (user ids, auth/cookie headers, query strings; client IP hashed) → OTTL redaction of URL tokens and SQL literals → **tail sampling** (errors, > 1 s, all of payment-processor, 5% baseline) → batch → Jaeger.
  - At scale this becomes a two-tier setup (agents with the `loadbalancing` exporter routing by trace ID), documented in the file.
- **New business/USE metrics:**
  - `circuit_breaker_open` (Stripe breaker).
  - `flash_sale_stock_drift_units_total` (reconciliation).
  - `sqs_queue_messages{queue,state,dlq}` (worker polls GetQueueAttributes).
  - `projection_lag_seconds` (renamed from `projection_lag_ms`, buckets up to 5 min).
  - Plus exporters for Postgres, Redis and Kafka consumer lag.
- **Alerts:**
  - `rules/causes.yml`: Postgres connections, DB pool waiting, Redis memory, Kafka lag, projection lag, DLQ not empty, job lag, flash-sale drift, ledger invariant, Stripe circuit, event-loop blocked, target down. Each links a runbook.
  - `rules/slo.generated.yml`: 9 SLOs, 81 rules.
  - Alertmanager routes `page` to on-call and `ticket` to the team channel; a page inhibits the ticket for the same SLO.
- **SLO generator:** recording rules per window (5m/30m/1h/6h/3d) and multi-window burn-rate alerts (14.4× 1h&5m page, 6× 6h&30m page, 1× 3d&6h ticket). It also writes `scripts/load-tests/slo-thresholds.json`, so k6 asserts the same targets.
- **Dashboards as code** (generated JSON, `allowUiUpdates: false`): API RED, async pipelines (Kafka lag, projection freshness, SQS/DLQ, jobs), flash sale & checkout, payments, LLM (ClickHouse: cost/day, TTFT, cache hit ratio, refusals, KYC outcomes and corrections).

## Test plan
| Scenario | API e2e | UI journey | Unit |
|---|---|---|---|
| SLO YAML → correct error-ratio PromQL and burn-rate thresholds | — | — | `slo-rules.spec.ts` |
| Generated rules / k6 thresholds up to date | CI: `pnpm slo:generate && git diff --exit-code` (O-02) | — | — |
| Config validity | CI: `promtool check rules`, `otelcol validate`, `amtool check-config` (O-02) | — | — |
