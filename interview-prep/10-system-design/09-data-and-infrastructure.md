# Data and Infrastructure Designs

Designs 28–41 of the practice catalog (`03-practice-catalog.md`). These are the "build the building block" prompts: schedulers, webhooks, ingestion, aggregation, caches, search, flags, auth, sandboxes.

---

## 28. Rate limiter

Full walkthrough: `02-worked-examples.md` Example 3; algorithms and Redis Lua implementation: `03-Databases/04` §7 and `04-API-Design/03` §3. Points to rehearse:
- Algorithms (fixed window, sliding log, sliding window counter, **token bucket**, leaky bucket, concurrency limiter) and their burst behavior.
- Where: edge/WAF (IP, DDoS) → gateway (per API key) → app (per tenant/business rule).
- Distributed state in Redis with atomic Lua; local pre-checks to cut Redis round trips; fail-open vs fail-closed per endpoint.
- Responses: `429`, `Retry-After`, `RateLimit` headers.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`TOKEN_BUCKET`](../../packages/backend/libs/infrastructure/rate-limit/lua.ts#L13): TOKEN_BUCKET Lua script implements the token bucket algorithm with refill rate and capacity. _(lua.ts)_
> - [`SLIDING_WINDOW`](../../packages/backend/libs/infrastructure/rate-limit/lua.ts#L49): SLIDING_WINDOW Lua script implements the sliding window counter algorithm. _(lua.ts)_
> - [`CONCURRENCY_ACQUIRE`](../../packages/backend/libs/infrastructure/rate-limit/lua.ts#L69): CONCURRENCY_ACQUIRE Lua script implements the concurrency limiter with leases. _(lua.ts)_
<!-- theory-links:end -->

---

## 29. Distributed job scheduler / background jobs

**Prompt variants:** "Run millions of scheduled jobs (reminders, reports)", "Design cron for a multi-tenant SaaS", "Background job system for our Node app".

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`JobsService`](../../packages/backend/libs/infrastructure/jobs/jobs.service.ts#L14): JobsService orchestrates enqueueing jobs, cancellation and cron schedule management. _(jobs.service.ts)_
> - [`JobWorker`](../../packages/backend/libs/infrastructure/jobs/job-worker.service.ts#L26): JobWorker claims, executes and retries jobs using lease-based ownership. _(job-worker.service.ts)_
<!-- theory-links:end -->

### Clarify
- One-off delayed jobs, recurring (cron) jobs, or both? Volume (jobs/s, total scheduled)? Timing precision (seconds vs minutes)? Max runtime? Exactly-once requirements?

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`EnqueueOptions`](../../packages/backend/libs/infrastructure/jobs/job-types.ts#L34): EnqueueOptions carries runAt for delayed jobs, plus idempotencyKey and maxAttempts. _(job-types.ts)_
> - [`CronService`](../../packages/backend/libs/infrastructure/jobs/cron-module/cron.service.ts#L8): CronService registers recurring cron jobs. _(cron.service.ts)_
<!-- theory-links:end -->

### Design
```
API: POST /jobs {type, payload, run_at | cron, idempotency_key}
jobs table (Postgres): id, type, payload, run_at, status, attempts, locked_by, locked_until, tenant_id
Scheduler/dispatcher: every second, claim due jobs:
   UPDATE jobs SET status='RUNNING', locked_by=$w, locked_until=now()+'5 min'
   WHERE id IN (SELECT id FROM jobs WHERE status='QUEUED' AND run_at <= now()
                ORDER BY run_at LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING *;
Workers execute ─► SUCCEEDED | retry with backoff (run_at = now() + 2^attempt) | DEAD after N attempts
Reaper: jobs RUNNING with locked_until < now() (worker died) → back to QUEUED
Recurring: a cron definition table; on each run, compute and insert the next occurrence (idempotent per (schedule, fire_time))
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`JobRow`](../../packages/backend/libs/infrastructure/jobs/job-types.ts#L21): JobRow is the DB job record with status, runAt and attempts. _(job-types.ts)_
> - [`JobStatus`](../../packages/backend/libs/infrastructure/jobs/job-types.ts#L19): JobStatus defines the job lifecycle states QUEUED, RUNNING, SUCCEEDED, DEAD, CANCELLED. _(job-types.ts)_
> - [`JobMaintenance`](../../packages/backend/libs/infrastructure/jobs/job-maintenance.service.ts#L25): JobMaintenance materializes schedules and reaps expired leases. _(job-maintenance.service.ts)_
<!-- theory-links:end -->
### Deep dives
- **At-least-once**: a worker can crash after doing the work but before marking it done, so jobs must be **idempotent** (idempotency key per job / per (schedule, fire time)).
- **Scaling**: Postgres + `SKIP LOCKED` handles thousands of jobs/s (pg-boss, graphile-worker). Beyond that: partition by time bucket and tenant, or a queue (SQS with delay ≤ 15 min; EventBridge Scheduler for millions of one-off schedules), or Redis-based (BullMQ: delayed jobs in a sorted set by timestamp).
- **Fairness**: per-tenant concurrency limits so one tenant's 1M jobs don't starve others.
- **Long-running jobs**: heartbeat to extend `locked_until`; checkpoint progress.
- **Cron in a replicated app**: never run cron in every replica. Use a dedicated scheduler (one active instance with leader election / advisory lock), K8s CronJob, or a managed scheduler.
- **Observability**: queue lag (now − oldest due `run_at`), failure rate per job type, dead-job count, duration percentiles.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`JobWorker`](../../packages/backend/libs/infrastructure/jobs/job-worker.service.ts#L26): JobWorker uses lease ownership and retries, so at-least-once jobs rely on idempotency. _(job-worker.service.ts)_
> - [`EnqueueOptions`](../../packages/backend/libs/infrastructure/jobs/job-types.ts#L34): EnqueueOptions provides an idempotencyKey per job. _(job-types.ts)_
> - [`load-tests/jobs-drain.js`](../../packages/backend/scripts/load-tests/jobs-drain.js): The jobs-drain load test benchmarks job throughput and horizontal scaling.
<!-- theory-links:end -->

### Theory
`03-Databases/02` §5 (`SKIP LOCKED`, advisory locks), `02-Node.js/05` (cron with replicas), `06-Distributed-Systems/01` (at-least-once, idempotency).

---

## 30. Webhook delivery platform

**Prompt variants:** "Design Stripe/GitHub webhooks", "Notify customers' systems when events happen in ours".

### Design
```
Domain events (outbox) ─► Event router: match event type → subscribed endpoints (per customer)
   ─► deliveries table (event_id, endpoint_id, status, attempts, next_attempt_at)
   ─► per-endpoint delivery queues/workers ─► HTTPS POST (signed) to customer endpoint
   ─► 2xx → delivered | timeout/5xx → retry with backoff (up to ~3 days) | permanently failing → disable endpoint + email
Dashboard: delivery logs, response codes, manual replay
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`WEBHOOK_QUEUE`](../../packages/backend/libs/domains/developer-platform/domain/webhook-events.ts#L5): WEBHOOK_QUEUE is the SQS FIFO queue for webhook deliveries. _(webhook-events.ts)_
> - [`WebhookDelivery`](../../packages/backend/libs/domains/developer-platform/domain/webhook-events.ts#L8): WebhookDelivery message carries endpoint, event and attempt for delivery and retry. _(webhook-events.ts)_
> - [`WebhooksController`](../../packages/backend/libs/domains/developer-platform/api/webhooks.controller.ts#L27): WebhooksController manages endpoints, delivery attempts, replay and test pings. _(webhooks.controller.ts)_
<!-- theory-links:end -->
### Deep dives
- **Signing**: `HMAC-SHA256(secret, timestamp + "." + body)` in a header; receivers verify and reject old timestamps (replay protection). Support two secrets during rotation.
- **Isolation between endpoints**: one slow or dead customer endpoint must not block others → per-endpoint queues or concurrency limits, short timeouts (~10 s), circuit breaker per endpoint.
- **Semantics**: at-least-once (receivers dedupe by `event.id`), no ordering guarantee (include timestamps/sequence; or send thin events and let receivers fetch current state).
- **SSRF protection**: customers supply URLs → resolve DNS and block private/internal IP ranges and cloud metadata addresses, re-check on each delivery (DNS rebinding), send from egress IPs you publish (customers allowlist them).
- **Payload versioning**: pinned API version per endpoint.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`signWebhook`](../../packages/backend/libs/domains/developer-platform/domain/signature.ts#L12): signWebhook signs the body with a timestamp and secrets in a Stripe-style header. _(signature.ts)_
> - [`verifyWebhook`](../../packages/backend/libs/domains/developer-platform/domain/signature.ts#L18): verifyWebhook verifies the signature and rejects old timestamps for replay protection. _(signature.ts)_
> - [`WebhookDeliverer`](../../packages/backend/libs/domains/developer-platform/application/webhook-deliverer.service.ts#L41): WebhookDeliverer handles retries, circuit breaking and endpoint health isolation. _(webhook-deliverer.service.ts)_
<!-- theory-links:end -->

### Theory
`04-API-Design/03` §5 (webhooks), `06-Distributed-Systems/03` (timeouts, circuit breakers, bulkheads), `05-Security/01` §6 (SSRF).

---

## 31. Analytics event ingestion / A/B testing

Full walkthrough: `02-worked-examples.md` Example 2 (deterministic assignment, exposure events, reliable ingestion, SRM checks). Points to rehearse:
- Client batching + `sendBeacon` on page hide; client-generated event IDs; ingest API that validates and returns `202` fast; queue (Kafka/Kinesis/SQS) to absorb peaks; consumers dedupe and write in batches to a columnar store (ClickHouse, BigQuery, Redshift) partitioned by day.
- Server-side events for business-critical conversions (via the outbox).
- Schema registry / validated event schemas; late and out-of-order events handled by event time, not arrival time.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`AnalyticsService`](../../packages/backend/libs/domains/experimentation/application/analytics.service.ts#L13): AnalyticsService ingests events, assigns variants, logs exposures and runs SRM checks. _(analytics.service.ts)_
> - [`ClientEvent`](../../packages/backend/libs/domains/experimentation/domain/event-schema.ts#L13): ClientEvent Zod schema validates client events with a UUID event id. _(event-schema.ts)_
> - [`ANALYTICS_TOPIC`](../../packages/backend/libs/domains/experimentation/domain/event-schema.ts#L9): ANALYTICS_TOPIC is the Kafka topic that absorbs ingested events. _(event-schema.ts)_
<!-- theory-links:end -->

---

## 32. Ad click aggregator / top-K trending

### Clarify
- Count clicks per ad per minute (billing!) and/or the top-K most viewed items in the last hour/day. Accuracy requirements: billing needs exact counts; trending can be approximate.
- Scale: 10k–1M events/s.

### Design
```
clicks ─► click service (redirect + log, fast) ─► Kafka (partitioned by ad_id)
   ─► stream processor (Flink / Kafka Streams / custom consumers): tumbling 1-min windows per ad_id
   ─► aggregates table (ad_id, minute, count) in OLAP store (ClickHouse/Druid) ─► dashboards, billing
   ─► raw events also to S3 (data lake) ─► periodic batch job recomputes and reconciles (lambda-style)
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ClickAggregator`](../../packages/backend/libs/domains/marketing/infra/click-aggregator.service.ts#L43): ClickAggregator consumes clicks, aggregates per minute and writes transactionally. _(click-aggregator.service.ts)_ · [Aggregating and billing ad clicks](../../docs/humans/concepts/domain-marketing/ad-click-aggregation-and-billing.md)
> - [`TrendingConsumer`](../../packages/backend/libs/domains/discovery/infra/trending.consumer.ts#L31): TrendingConsumer streams analytics into per-category trending. _(trending.consumer.ts)_
<!-- theory-links:end -->
### Deep dives
- **Exactly-once counting**: dedupe click IDs (impression/click tokens); Kafka transactions / idempotent sinks (upsert aggregates by (ad, window)); batch reconciliation from raw events catches drift. Billing uses the reconciled numbers.
- **Windows and late events**: event-time windows with **watermarks** (allow N minutes of lateness); late events after that go to a correction path.
- **Hot keys**: a viral ad overloads one partition → add a random suffix to the key (`ad_id#0..9`), pre-aggregate per sub-key, then merge.
- **Top-K**: exact = count per item + a heap of size K per window; approximate at very high cardinality = **Count-Min Sketch** for counts + a heap of candidates. Multi-level: per-partition top-K merged into a global top-K.
- **Fraud**: click-spam filtering (same IP/device bursts) before billing.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Exactly-once Kafka transaction for aggregates and offsets](../../docs/humans/concepts/domain-marketing/exactly-once-transaction.md): Aggregates and consumer offsets are committed in one Kafka transaction for exactly-once counting. [`ClickAggregator`](../../packages/backend/libs/domains/marketing/infra/click-aggregator.service.ts#L43)
> - [`TumblingWindows`](../../packages/backend/libs/domains/discovery/domain/count-min-sketch.ts#L106): TumblingWindows implements event-time windows with a watermark and late-event tracking. _(count-min-sketch.ts)_
> - [Daily reconciliation against the raw click log](../../docs/humans/concepts/domain-marketing/daily-reconciliation.md): The daily reconciliation recounts from the raw click log and corrects drift. [`ad-billing.jobs.ts`](../../packages/backend/libs/domains/marketing/infra/ad-billing.jobs.ts), [`ad-billing.jobs.ts`](../../packages/backend/libs/domains/marketing/infra/ad-billing.jobs.ts)
<!-- theory-links:end -->

### Theory
`06-Distributed-Systems/01` (Kafka partitions, transactions), `11-Algorithms-Coding/03` (heaps), design 33.

---

## 33. Metrics and logging platform

### Design
- **Metrics**: agents/apps expose or push metrics → collector (OTel Collector) → **time-series DB** (Prometheus for single cluster, Mimir/Thanos/VictoriaMetrics for long-term and multi-cluster). Data model: metric name + labels → series of (timestamp, value). Storage: compressed chunks per series (delta-of-delta timestamps, XOR floats), downsampling for old data (raw for 15 days, 5-min rollups for a year).
- **Logs**: apps write JSON to stdout → node agent (Fluent Bit/Vector) → buffer (Kafka) → indexer (Elasticsearch/OpenSearch: full-text indexed, expensive; or **Loki**: only labels indexed, content scanned at query time, cheap) → object storage for retention.
- **Alerting**: rule evaluation against the TSDB → Alertmanager → routing, dedupe, silencing, paging.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`startTelemetry`](../../packages/backend/libs/common/telemetry/telemetry.ts#L75): startTelemetry bootstraps the OpenTelemetry SDK with Prometheus metrics endpoints. _(telemetry.ts)_ · [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md)
> - [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md): The telemetry module generates Prometheus SLO alerting rules.
<!-- theory-links:end -->

### Deep dives
- **Cardinality** is the main scaling enemy: every unique label combination is a new series. Limit labels (no user IDs/request IDs), enforce per-tenant series limits.
- **Ingestion backpressure**: buffer in Kafka; drop debug logs first under pressure; sampling.
- **Cost**: retention tiers, sampling of high-volume success logs, keep all errors.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`METRIC_VIEWS`](../../packages/backend/libs/common/telemetry/telemetry.ts#L37): METRIC_VIEWS enforces cardinality limits and attribute allowlists per instrument. _(telemetry.ts)_ · [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md)
<!-- theory-links:end -->

### Theory
`07-Observability-Reliability/02` (metric types, cardinality, OTel), `07-Observability-Reliability/01` (alerting).

---

## 34. Distributed cache

### Clarify
- A Redis/Memcached-like cluster: get/set with TTL, size (TBs?), QPS (millions?), consistency expectations (cache = OK to lose).

### Design
- **Sharding** by key with **consistent hashing** (hash ring with virtual nodes) so adding or removing a node moves only ~1/N of the keys. Redis Cluster instead uses 16,384 fixed hash slots assigned to nodes.
- Each node: in-memory hash table + eviction (approximate LRU/LFU by sampling), TTL expiry (lazy on access + periodic sampling).
- **Replication** for availability (async primary → replica); failover via a coordinator (Sentinel-like) or cluster gossip.
- **Client side**: smart clients know the topology (slot map) and route directly; connection pooling; request pipelining.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`HashRing`](../../packages/backend/libs/domains/catalog/domain/hash-ring.ts#L12): HashRing implements consistent hashing with virtual nodes. _(hash-ring.ts)_
> - [`reactionKey`](../../packages/backend/libs/domains/launch-events/infra/live-keys.ts#L13): reactionKey shards Redis keys across 8 cluster nodes. _(live-keys.ts)_
<!-- theory-links:end -->

### Deep dives
- Hot keys (replicate them to several nodes / L1 in-process caches), big values, thundering herd on expiry (single-flight, jittered TTLs), consistency with the DB (cache-aside + delete on write).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`CacheService`](../../packages/backend/libs/infrastructure/cache/cache.service.ts#L48): CacheService has single-flight stampede prevention, an L1 in-process cache and hot-key promotion. _(cache.service.ts)_
> - [`HotKeyDetector`](../../packages/backend/libs/infrastructure/cache/hot-key-detector.ts#L7): HotKeyDetector promotes frequently accessed keys to the L1 cache. _(hot-key-detector.ts)_
<!-- theory-links:end -->

### Theory
`03-Databases/04` (Redis cluster, eviction, stampede, invalidation).

---

## 35. Web crawler

### Clarify
- Scope (whole web vs specific sites), pages per day (e.g., 1B/day ≈ 12k/s), freshness, respect robots.txt, storage of raw HTML.

### Design
```
Seed URLs ─► URL frontier (priority + politeness queues per host)
   ─► fetchers (async HTTP, DNS cache) ─► content store (S3, raw HTML)
   ─► parser: extract links + content ─► URL dedupe (seen set: Bloom filter + DB) ─► frontier
   ─► content dedupe (hash / SimHash for near-duplicates) ─► indexer / downstream
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`CrawlerService`](../../packages/backend/libs/domains/seller-insights/application/crawler.service.ts#L35): CrawlerService schedules and runs crawls with change detection. _(crawler.service.ts)_
> - [`Frontier`](../../packages/backend/libs/domains/seller-insights/infra/frontier.ts#L29): Frontier is the URL frontier with per-host queues. _(frontier.ts)_
<!-- theory-links:end -->
### Deep dives
- **Politeness**: one queue per host, rate limit per host (and per IP), honor `robots.txt` (cached) and `Crawl-delay`.
- **Prioritization**: PageRank-ish importance, change frequency (re-crawl schedule), freshness requirements.
- **Dedupe**: normalized URLs (strip tracking params, lowercase host) checked against a Bloom filter (memory-efficient, small false-positive rate) backed by a persistent store.
- **Traps**: infinite calendars, session IDs in URLs → max depth per site, URL pattern limits.
- **Distribution**: partition the frontier by host hash so one worker owns a host (politeness becomes local).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`Frontier`](../../packages/backend/libs/domains/seller-insights/infra/frontier.ts#L29): Frontier gives per-host FIFO queues with rate limiting and leases. _(frontier.ts)_
> - [`parseRobots`](../../packages/backend/libs/domains/seller-insights/domain/robots.ts#L12): parseRobots parses robots.txt including crawl-delay. _(robots.ts)_
<!-- theory-links:end -->

### Theory
`06-Distributed-Systems/01` (queues), `06-Distributed-Systems/03` (backoff, rate limiting).

---

## 36. Data sync / ETL integration platform

**Prompt variants:** "Sync data between our system and CRM/HRIS/accounting providers", "Build connectors for third-party APIs", "Keep a legacy system in sync during a migration".

### Design
```
Connector configs (per tenant, per provider; credentials in Secrets Manager / OAuth tokens with refresh)
Scheduler ─► sync jobs per (tenant, provider, entity) ─► queue
Workers: fetch incrementally (cursor/watermark, with overlap) through a per-provider rate limiter (shared in Redis)
   ─► normalize (anti-corruption layer, zod validation, raw payload kept in JSONB)
   ─► idempotent upsert by (provider, external_id) ─► emit change events (outbox)
Webhooks from providers ─► fast ACK ─► queue ─► same upsert path
Nightly reconciliation: compare IDs/hashes, detect deletes, fix drift, report
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`IntegrationSyncService`](../../packages/backend/libs/domains/catalog-sync/application/integration-sync.service.ts#L37): IntegrationSyncService does incremental sync with watermarks, webhooks and reconciliation. _(integration-sync.service.ts)_
> - [`CommerceProvider`](../../packages/backend/libs/domains/catalog-sync/domain/provider.port.ts#L28): CommerceProvider is the port that provider connectors implement. _(provider.port.ts)_
<!-- theory-links:end -->
### Deep dives
- **Incremental sync** with watermarks + overlap windows; checkpoint after each page; backfills on separate queues so they don't starve incremental syncs.
- **Rate limits**: distributed token bucket per provider and per tenant credential; honor `Retry-After`; backoff with jitter; circuit breaker for provider outages.
- **Bidirectional**: field ownership (system of record per field), echo suppression (origin tagging, last-synced hashes), conflict queue for humans.
- **Schema drift**: validation failures go to a quarantine table with alerts, not crashes.
- **Observability**: per connector: lag (now − watermark), error rate, records processed, reconciliation drift.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`IntegrationSyncService`](../../packages/backend/libs/domains/catalog-sync/application/integration-sync.service.ts#L37): Incremental sync tracks watermarks. _(integration-sync.service.ts)_
> - [`BACKFILL_QUEUE`](../../packages/backend/libs/domains/catalog-sync/application/integration-sync.service.ts#L19): BACKFILL_QUEUE keeps backfills apart from incremental SYNC_QUEUE work. _(integration-sync.service.ts)_
<!-- theory-links:end -->

### Theory
`06-Distributed-Systems/02` §3–5 (bidirectional sync, ETL, reconciliation), `04-API-Design/03` §4 (consuming rate-limited APIs).

---

## 37. Product search (catalog search with filters)

### Design
```
Postgres (source of truth) ─► outbox/CDC ─► indexer ─► Elasticsearch/OpenSearch index (denormalized product docs)
Search API ─► ES query: full-text (BM25 + boosts) + filters (category, price range, in stock) + facets (aggregations) + sort
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ProductSearchProjector`](../../packages/backend/libs/domains/catalog/infra/product-search.projector.ts#L23): ProductSearchProjector builds the Elasticsearch read model for product search. _(product-search.projector.ts)_
> - [`ProductSearchParams`](../../packages/backend/libs/infrastructure/elasticsearch/types.ts#L22): ProductSearchParams carries query, filters, facets, sort and pagination. _(types.ts)_ · [elasticsearch](../../docs/humans/concepts/platform-elasticsearch/elasticsearch.md)
<!-- theory-links:end -->
### Deep dives
- **Sync**: CDC/outbox → idempotent indexing by product ID with a version (ignore out-of-order older versions); full reindex via a new index + **alias swap** (zero downtime).
- **Relevance**: field boosts (title > description), synonyms, typo tolerance (fuzziness), language analyzers, business boosts (in stock, margin); evaluate with query logs and click-through.
- **Facets**: aggregations on keyword fields; filters in `filter` context (cached, not scored).
- **When Postgres is enough**: `tsvector` + GIN + `pg_trgm` for small catalogs and simple needs (`03-Databases/01` §9).
- **Consistency**: search results are eventually consistent; re-check stock/price from the DB on the product page and at checkout.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`SearchReindexService`](../../packages/backend/libs/domains/discovery/application/search-reindex.service.ts#L41): SearchReindexService reindexes with an atomic alias swap. _(search-reindex.service.ts)_
> - [`UpsertProductDocument`](../../packages/backend/libs/infrastructure/elasticsearch/types.ts#L4): UpsertProductDocument carries a version and business boost fields. _(types.ts)_ · [elasticsearch](../../docs/humans/concepts/platform-elasticsearch/elasticsearch.md)
<!-- theory-links:end -->

---

## 38. Feature flags / remote config service

### Design
- Flag definitions (key, variants, targeting rules: user attributes, % rollout by hashed user ID, tenant allowlists) stored in a DB with an admin UI and audit log.
- **Evaluation happens locally in SDKs**: services download the full ruleset at startup and keep it updated via streaming (SSE) or polling, then evaluate in memory (microseconds, no network call per check, still works if the flag service is down). Browser SDKs get pre-evaluated flags for the current user (rules aren't exposed to clients).
- Consistent percentage rollouts: `hash(flagKey + userId) % 100 < rolloutPercent`, so a user stays in the same bucket as the percentage grows.
- Exposure events for experiments (design 31); kill switches; stale-flag cleanup (flags are tech debt).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`FlagsClient`](../../packages/backend/libs/domains/experimentation/infra/flags.client.ts#L33): FlagsClient keeps flags in memory, updated by realtime push and polling. _(flags.client.ts)_
> - [`evaluate`](../../packages/backend/libs/domains/experimentation/domain/evaluator.ts#L88): evaluate runs the targeting rules and rollouts locally. _(evaluator.ts)_
<!-- theory-links:end -->

### Theory
`08-DevOps-Cloud/01` (progressive delivery), `02-worked-examples.md` Example 2 (assignment hashing).

---

## 39. Authentication / SSO service

### Design
- Identity provider (or Auth0/Cognito/Keycloak): users, credentials (Argon2id hashes), MFA/passkeys, sessions, OAuth 2 / OIDC endpoints (`/authorize`, `/token`, `/userinfo`, JWKS), SAML for enterprise SSO, SCIM provisioning.
- Apps: Authorization Code + PKCE; short-lived access tokens (JWT, verified locally via cached JWKS) + rotating refresh tokens (stored server-side, reuse detection); browser apps through a BFF with HttpOnly cookies.
- Session management: central session store (Redis) for revocation ("log out all devices"), token introspection or short TTLs for revocation latency.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`AuthSessionService`](../../packages/backend/libs/domains/identity/application/auth-session.service.ts#L34): AuthSessionService handles login, MFA, tokens and refresh rotation. _(auth-session.service.ts)_
> - [`SessionStore`](../../packages/backend/libs/domains/identity/infra/sessions/session-store.service.ts#L35): SessionStore rotates refresh tokens and detects reuse. _(session-store.service.ts)_
> - [`ShopSsoService`](../../packages/backend/libs/domains/tenancy/application/shop-sso.service.ts#L13): ShopSsoService configures per-shop enterprise OIDC SSO. _(shop-sso.service.ts)_
<!-- theory-links:end -->

### Deep dives
- Key rotation (publish new key in JWKS before signing with it), brute-force protection, account recovery flows (the weakest link), audit logs, multi-tenant IdP configuration per tenant.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`KeyRotationJobs`](../../packages/backend/libs/domains/identity/infra/keys/key-rotation.jobs.ts#L24): KeyRotationJobs rotates, promotes and retires signing keys daily. _(key-rotation.jobs.ts)_
> - [`ShopSsoService`](../../packages/backend/libs/domains/tenancy/application/shop-sso.service.ts#L13): ShopSsoService stores a per-tenant IdP configuration. _(shop-sso.service.ts)_
<!-- theory-links:end -->

### Theory
`05-Security/02` (sessions vs JWT, OAuth/OIDC, password hashing, service-to-service).

---

## 40. Online judge / code execution (LeetCode)

### Design
```
Submit code ─► API stores submission (QUEUED) ─► queue ─► runner workers
Runner: start an isolated sandbox per submission (Firecracker microVM / gVisor / locked-down container):
   no network, read-only FS, CPU/memory/time limits (cgroups), non-root, seccomp
   compile → run against test cases → collect results → destroy sandbox
Results ─► DB ─► client polls or receives SSE update
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ShopFunctionsService`](../../packages/backend/libs/domains/shop-functions/application/shop-functions.service.ts#L34): ShopFunctionsService handles submit, test and run of seller code. _(shop-functions.service.ts)_
> - [`TEST_RUN_QUEUE`](../../packages/backend/libs/domains/shop-functions/application/shop-functions.service.ts#L12): TEST_RUN_QUEUE is the queue for async judge runs. _(shop-functions.service.ts)_
> - [`FunctionJudgeModule`](../../packages/backend/libs/domains/shop-functions/shop-functions.module.ts#L76): FunctionJudgeModule runs the async judge worker. _(shop-functions.module.ts)_
<!-- theory-links:end -->
### Deep dives
- **Untrusted code isolation** is the core: containers alone share the kernel, so add gVisor or microVMs; strict resource limits; no outbound network; kill on timeout.
- Contest spikes: autoscale runners on queue depth; prioritize contest submissions; pre-warmed sandbox pools.
- Test data never sent to clients; anti-cheating (plagiarism detection) offline.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`FunctionSandbox`](../../packages/backend/libs/domains/shop-functions/infra/sandbox.ts#L26): FunctionSandbox isolates untrusted JS in V8 sandboxes with memory caps and timeouts. _(sandbox.ts)_
> - [`SandboxResult`](../../packages/backend/libs/domains/shop-functions/infra/sandbox.ts#L5): SandboxResult models timeout and memory-limit outcomes. _(sandbox.ts)_
<!-- theory-links:end -->

### Theory
`05-Security/01` §7.6 (`vm` is not a sandbox), `08-DevOps-Cloud/01` (resource limits), design 29 (queues).

---

## 41. Historical / "as-of" reporting

Full walkthrough: `02-worked-examples.md` Example 5 and `03-Databases/03` §7 (valid-time ranges, bitemporal modeling, period snapshots, adjustments instead of edits to closed periods).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`StatementService`](../../packages/backend/libs/domains/statements/application/statement.service.ts#L33): StatementService computes as-of statements via bitemporal rate lookups, snapshots and retroactive adjustments. _(statement.service.ts)_
> - [Correction of one hour with an ADJUSTMENT journal](../../docs/humans/concepts/domain-marketing/adjust-journal.md): An ADJUSTMENT journal corrects an already-billed period rather than editing it. [`ad-billing.jobs.ts`](../../packages/backend/libs/domains/marketing/infra/ad-billing.jobs.ts)
<!-- theory-links:end -->
