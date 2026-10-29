# arch-17. Metrics and logging platform

*Observability · Medium*

## The question

"Our SaaS company runs ~10,000 pods across several Kubernetes clusters. Teams want one platform for metrics, logs and alerts: dashboards with 15-second resolution, 13 months of metric history, log search over the last 7 days, and alerting that pages the right team. We're paying a vendor too much. Design the platform."

**Then:** "A deploy adds `request_id` as a metric label and active series jump from 10M to 80M within an hour. And during an incident, the log cluster itself falls over."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Build vs buy? → assume: self-host open-source components on Kubernetes + S3; a managed Prometheus/Grafana is a valid answer if the team is small. Decide by cost per active series and per GB of logs vs engineers needed.
- Traces? → assume: OpenTelemetry tracing exists separately (sampled); this design covers metrics, logs, alerts.
- Multi-team isolation? → assume: each team is a tenant with its own limits.
- Log search needs? → assume: filter by labels (service, pod, level) then grep text; full-text relevance not needed.
- Numbers, metrics → assume: 10k pods × ~1,000 series = 10M active series at 15 s scrape → ~670k samples/s. At 1-2 bytes/sample compressed (Prometheus TSDB / Gorilla-style encoding) ≈ 60-120 GB/day raw resolution.
- Numbers, logs → assume: 10k pods × ~50 lines/s × ~300 B ≈ 150 MB/s ≈ 13 TB/day uncompressed; ~10x compression in object storage → ~1.3 TB/day; 7 days hot, 90 days archive.

## Design

**Metrics path**
1. Prometheus in agent mode (or the OTel Collector) per cluster scrapes pods and `remote_write`s to the metrics backend.
2. Backend: Grafana Mimir (or Thanos/VictoriaMetrics): distributors validate and apply per-tenant limits, ingesters keep ~2 h of recent data in memory with a WAL and replication factor 3, then flush 2 h blocks to S3; compactors merge blocks and downsample (5 m resolution after 15 days, kept 13 months). Queriers read ingesters + S3, with a results cache.
3. Retention: raw 15 days, 5-minute downsample 13 months. Long-range dashboards use downsampled data automatically.

**Logs path**
1. OTel Collector as a DaemonSet tails container logs, adds Kubernetes metadata (namespace, pod, service), parses JSON, drops debug logs in prod by default.
2. Sends to Kafka (buffer, 24 h retention) → log ingesters.
3. Backend: Grafana Loki (indexes only labels, stores compressed chunks in S3) or ClickHouse. Query = pick a label stream, then filter text. Hot 7 days, S3 archive 90 days with lifecycle to Glacier.

**Alerting**
1. Rule evaluators (Mimir ruler) run recording rules and alert rules per team.
2. Alertmanager: grouping (one page for 50 pods failing the same way), inhibition (cluster down suppresses pod alerts), silences, routing by `team` label to PagerDuty/Slack.
3. SLO alerts use multi-window burn rates (e.g. page when the 1 h and 5 m windows both burn the error budget at ≥ 14.4x), not raw thresholds.

**Limits per tenant:** max active series, max series per metric, max label value length, ingestion rate (samples/s), log GB/day. Exceeding → samples rejected with a counter the team can see, not a platform outage.

**Meta-monitoring:** a separate small Prometheus watches the platform; an always-firing "watchdog" alert goes to an external dead-man's-switch service that pages if it stops arriving.

## Deep dives

**1. Cardinality explosion (twist, part 1).** `request_id` makes every request a new series; ingester memory scales with active series, so 80M series OOM-kill ingesters and every team loses metrics. Chosen: per-tenant series limits (that team hits its limit and its new series are rejected; others are unaffected), a per-metric series limit, a relabel rule at the collector dropping known high-cardinality labels (`request_id`, `user_id`, `url` with IDs), a cardinality dashboard per team, and a CI check on metric definitions. Per-request data belongs in traces and logs, not metric labels. Rejected: scaling ingesters to fit (8x cost for data nobody can query meaningfully).

**2. Log cluster down during an incident (twist, part 2).** Logs are needed most exactly when load is highest. Chosen: Kafka in front of ingestion, so collectors keep shipping while the backend is down and ingestion catches up afterwards; collectors have a disk buffer for Kafka outages; per-tenant ingestion limits so one service's error loop (100k lines/s of the same stack trace) can't take the cluster down; the incident runbook starts from metrics and traces, which live on separate systems. Rejected: collectors writing straight to the log store (an outage = lost logs).

**3. Label index vs full-text index.** OpenSearch/Elasticsearch indexes every token: flexible search, but storage and RAM costs are roughly the size of the raw data or more. Loki indexes only labels and greps compressed chunks: far cheaper, slower for needle-in-haystack queries across all services. Chosen: Loki/ClickHouse for operational logs; full-text only for a small set (audit/security logs) that needs it.

## Traps

- Unbounded label values (user IDs, request IDs, raw URLs) in metrics.
- No per-team limits: one team's mistake becomes everyone's outage.
- Monitoring the monitoring system with itself: when it's down, nothing alerts. Use an external dead man's switch.
- Paging on causes (CPU > 80%) rather than symptoms (SLO burn): noisy pages that teams learn to ignore.
- Keeping 13 months at 15-second resolution: storage and query cost for detail nobody reads after two weeks.
- Shipping logs directly to the store without a buffer: logs are lost during the incidents you need them for.

## Say it (60–90 s)

For metrics, Prometheus agents in each cluster scrape pods every fifteen seconds and remote-write to a horizontally scaled backend such as Mimir. Ingesters hold the last two hours in memory with a write-ahead log and replication, then flush blocks to S3; compactors downsample to five minutes after fifteen days and keep that for thirteen months. Ten million active series is about six hundred seventy thousand samples a second and around a hundred gigabytes a day. For logs, an OpenTelemetry collector on every node tails container logs, adds Kubernetes labels and ships to Kafka, then into Loki, which indexes only labels and keeps compressed chunks in S3; that's roughly thirteen terabytes a day raw. Alerting runs rules per team, and Alertmanager groups, inhibits and routes by team; SLO alerts use burn rates. Every team has limits on active series, series per metric and log volume. That handles the request ID label: that team's new series are rejected and everyone else keeps working, and the collector drops known high-cardinality labels. Kafka in front of the log store means a log outage delays logs instead of losing them, and an external dead-man's switch tells us when the platform itself is down.

## Follow-ups

**Q:** How do you decide build vs buy?
**A:** Compare the vendor bill (priced per host, per custom metric/series and per GB ingested) against infrastructure plus at least 2-3 engineers to run it. Under that, buy; well above it, self-host. Either way, the same cardinality and volume controls cut the bill.

**Q:** How do you stop teams logging too much?
**A:** Per-team GB/day quotas with visible usage, sampling for high-volume info logs, debug off by default in prod, and charging back cost per team.

**Q:** How do you make an alert actionable?
**A:** Every page links a runbook and a dashboard, has an owner label, is based on user-facing symptoms, and gets reviewed if it fires without action twice.

</details>

## Theory in the notes

- [07-observability-reliability/02-logs-metrics-traces.md](../../07-observability-reliability/02-logs-metrics-traces.md)
- [07-observability-reliability/01-sli-slo-error-budgets-alerting-runbooks.md](../../07-observability-reliability/01-sli-slo-error-budgets-alerting-runbooks.md)
- [10-system-design/09-data-and-infrastructure.md](../../10-system-design/09-data-and-infrastructure.md)
- [08-devops-cloud/01-kubernetes-probes-and-deployment-strategies.md](../../08-devops-cloud/01-kubernetes-probes-and-deployment-strategies.md)
