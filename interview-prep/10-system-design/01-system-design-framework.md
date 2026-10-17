# System Design Interview Framework

---

## 1. The 45-minute structure

| Time | Step | What to produce |
|---|---|---|
| 0–5 | **Requirements** | functional (3–5 core use cases), non-functional with **numbers** (users, QPS, latency SLO, availability, consistency needs, data retention, compliance) — explicitly say what's **out of scope** |
| 5–10 | **Estimates** | QPS (avg & peak), storage/year, bandwidth, read:write ratio → tells you what's hard |
| 10–15 | **API & data model** | key endpoints/events; main entities and access patterns; choose storage per access pattern |
| 15–25 | **High-level design** | boxes & arrows for the main flow; walk a request through it |
| 25–40 | **Deep dives** | 2–3 hardest parts (interviewer often picks): scaling the hot path, consistency, failure handling, data partitioning |
| 40–45 | **Wrap-up** | bottlenecks, trade-offs made, monitoring/SLOs, what you'd do with more time / at 10× scale |

Habits that score points:
- **Ask before designing.** Confirm assumptions out loud.
- **Name trade-offs**: "I'm choosing X over Y because of Z. If the requirement were W, I'd pick Y."
- **Start simple**, then scale. Don't open with Kafka plus 12 microservices.
- **Drive the conversation**, but take the interviewer's hints.
- Talk about **failure modes** and **observability** without being asked.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Payment status values](../../docs/humans/concepts/domain-payments/payment-status.md): Defines the explicit payment states (PENDING, COMPLETED, FAILED, CANCELLED, REFUNDED, UNKNOWN) that requirements around correctness and consistency are modelled with. [`PaymentStatus`](../../packages/backend/libs/domains/payments/infra/models/payment.model.ts#L33)
<!-- theory-links:end -->

---

## 2. Back-of-the-envelope numbers

- 1 day ≈ 86,400 s ≈ **10^5 s**. 1M requests/day ≈ **12 QPS** average. Peak ≈ 2–10× average.
- 1 month ≈ 2.6M s. 1 year ≈ 3.15 × 10^7 s.
- A Node process: roughly 1–10k simple req/s depending on the work.

Datastores and brokers: **rough single-node figures** on typical cloud hardware (8–16 vCPU, NVMe/gp3), small records, same AZ. Real numbers swing 10× with record size, indexes, durability settings and query shape. Use them for "is this one box or a cluster?", not capacity planning.

| System | Latency (p50, incl. network) | Throughput per node | How it scales out | Pick it for |
|---|---|---|---|---|
| **Redis** | 0.2–1 ms | 100k–200k ops/s (single-threaded core; 1M+ with pipelining) | Cluster: hash slots across shards | cache, counters, rate limits, locks, sessions, leaderboards |
| **Postgres / MySQL** | point read 0.5–2 ms; durable commit 1–5 ms (+ RTT with a sync replica) | ~10k–50k simple reads/s; ~5k–20k simple write tx/s; complex queries far less | read replicas, partitioning, then sharding (Citus/Vitess); **one writer** per shard | default for transactional data, joins, constraints |
| **MongoDB** | 1–2 ms point ops | ~10k–50k ops/s per replica-set primary | sharding by shard key | flexible documents, nested aggregates read whole |
| **Cassandra** | write 1–5 ms (append to commitlog + memtable); read 2–10 ms | ~10k–50k writes/s per node; **linear**: add nodes → millions/s per cluster | leaderless ring, tunable consistency, multi-region active-active | huge write volume, time series, known query patterns |
| **ScyllaDB** | sub-ms to low-ms p99 | ~100k–1M ops/s per node (C++, shard-per-core) | same model as Cassandra (wire-compatible) | Cassandra workloads with fewer nodes and steadier p99 |
| **DynamoDB** | single-digit ms | per partition: 1k writes (WCU) / 3k reads (RCU) per second; table ≈ unlimited | automatic partitioning by key | serverless key-value at any scale |
| **Elasticsearch / OpenSearch** | search 10–100 ms; new docs visible after **refresh ≈ 1 s** | bulk indexing ~10k–50k docs/s per node | shards + replicas | full-text search, filtering, log analytics; **not** a source of truth |
| **Kafka** | produce 2–10 ms (`acks=all`); end-to-end 5–50 ms | 100+ MB/s, ~100k–1M msgs/s per broker; ~10 MB/s per partition | add partitions/brokers | event streams, replay, fan-out, high throughput |
| **SQS** | 10–50 ms per API call | standard: near-unlimited; FIFO: 300 calls/s per action (3k msg/s batched); high-throughput FIFO: up to 70k calls/s (700k msg/s batched) in the biggest regions, 2.4k calls/s in most | managed | work queues, buffering, retry/DLQ |
| **S3** | first byte 20–100 ms | 3,500 writes / 5,500 reads per s **per prefix** | spread keys across prefixes | blobs, archives, data lake |
| **ClickHouse** | 10 ms to seconds | scans hundreds of millions to billions of rows/s; insert in batches | shards + replicas | analytics, aggregations over huge tables |

Reading the table: a webhook integration doing 1,000 events/min (≈17/s) is trivial for one Postgres. Cassandra/Scylla start paying off at sustained **100k+ writes/s** or multi-region writes. Kafka at **tens of thousands of msgs/s** or when you need replay/fan-out.

Latency numbers (orders of magnitude):

| Operation | Time |
|---|---|
| L1 cache ref | ~1 ns |
| Main memory ref | ~100 ns |
| Redis GET within same AZ | ~0.2–1 ms |
| SSD random read | ~16–100 µs |
| Simple indexed Postgres query (in-memory) | ~0.1–1 ms + network |
| Round trip within same datacenter/AZ | ~0.5 ms |
| Cross-AZ | ~1–2 ms |
| Cross-continent round trip | ~100–150 ms |

Storage example: 10M users × 1 KB profile = 10 GB (tiny). 1B events/day × 200 B = 200 GB/day ≈ **73 TB/year** (now partitioning and a warehouse matter).

### Drawing the architecture
**Notation**: the **C4 model** is the de-facto standard for software architecture diagrams. Four zoom levels: Context (our system + users + external systems) → Containers (apps, DBs, queues) → Components (modules inside one app) → Code. Most interview and design-doc diagrams are a **Container** diagram. Add a **sequence diagram** (UML) for any flow where order/timing matters (retries, ack-after-commit). Rules: label every arrow with what flows and how (`POST webhook (HMAC)`, `INSERT`, `wake-up msg`), show DBs as cylinders and queues distinctly, include a legend if colors mean something.

| Tool | Style | Best for |
|---|---|---|
| **Excalidraw** | hand-drawn whiteboard, free, browser, live collab | **interviews** and quick sketches; the usual pick in remote system-design rounds |
| **Mermaid** | diagrams as code in Markdown; GitHub, GitLab, Obsidian, Notion render it | notes, READMEs, docs-as-code, version control (this folder) |
| **draw.io / diagrams.net** | free, polished boxes, official AWS/GCP/Azure icon sets, VS Code extension | detailed cloud architecture diagrams |
| **Structurizr / C4-PlantUML** | C4 as code: one model, many generated views | keeping C4 diagrams consistent in big systems |
| **PlantUML / D2** | text-to-diagram, strong sequence diagrams (PlantUML), modern layouts (D2) | sequence and component diagrams in repos |
| **Miro / Lucidchart / FigJam** | commercial collaborative canvases | team workshops, company docs |
| **Eraser.io, IcePanel, Cloudcraft** | AI-assisted / C4-native / 3D AWS views | niche: generating from text, interactive C4, AWS cost views |

**Arrow semantics.** No universal standard has a dedicated "HTTP arrow". The meaning goes in the **line style + label + legend**:
| Line | Means | Label example |
|---|---|---|
| solid → | **synchronous** request/response (HTTP, gRPC, SQL) | `POST /webhooks [HTTPS/JSON]`, `reads/writes [SQL]` |
| dashed → | **asynchronous** message/event (queue, topic, webhook fire-and-forget) | `wake-up msg [SQS]`, `LeaseUpdated [Kafka]` |
| double/thick ↔ | long-lived **stream / connection** | `[WebSocket]`, `[gRPC stream]`, `[SSE]` |
- **Direction = who initiates** (the caller/dependency), not which way data flows; a response is implied. A poller points *at* the API it polls.
- Every arrow: verb + payload + `[protocol]`. Always add a legend.
- This mirrors UML sequence diagrams, the one place arrows are standardized: filled head = sync call, open head = async message, dashed = return.

Notations that *do* standardize relationships:
- **ArchiMate** (The Open Group): typed relationships (serving, flow, triggering, access read/write…) each with a fixed arrow; free tool **Archi**. Enterprise-level, abstract.
- **Enterprise Integration Patterns** icons: channel, router, **resequencer**, dead-letter channel; draw.io ships the EIP shape library. Good for messaging pipelines.
- **Structurizr DSL** (C4 as code): `receiver -> inbox "Stores raw event" "SQL"`, and styles bound to tags (tag `Async` → dashed), so the convention is enforced, not remembered.
- **IcePanel**: GUI C4 tool where connections carry a technology, the closest to "draw.io with typed arrows".
- **AsyncAPI + EventCatalog**: spec + docs site for event-driven systems (producers, channels, consumers).
- Threat-model data-flow diagrams (**OWASP Threat Dragon**): flows have a protocol property and trust boundaries.

Interview tip: practice drawing in **Excalidraw** (or whatever the company's platform offers) so tool friction doesn't eat minutes; draw boxes as you talk, left→right in the order data flows.

---

## 3. Building blocks and when to use them

| Need | Block | Key considerations |
|---|---|---|
| Distribute traffic | Load balancer (L4/L7) | health checks, TLS termination, sticky sessions (avoid) |
| Static/edge caching | CDN | cache keys, invalidation, signed URLs |
| Relational data, transactions | PostgreSQL | indexes, replicas, partitioning, pooling |
| Massive key-value, predictable access | DynamoDB/Cassandra | partition key design, no ad-hoc queries |
| Hot data, counters, rate limits, sessions | Redis | eviction, persistence, failover loss |
| Async work, buffering, decoupling | SQS/RabbitMQ | at-least-once, DLQ, idempotency |
| Event streaming, replay, multiple consumers | Kafka | partitions, keys, ordering, retention |
| Search, fuzzy, facets | Elasticsearch/OpenSearch | sync via CDC/outbox, eventual consistency |
| Blobs/files | S3 | presigned URLs, lifecycle |
| Analytics | warehouse (BigQuery/Snowflake/Redshift/ClickHouse) | ELT from CDC/events, columnar |
| Workflows | Step Functions/Temporal | durable state, retries, compensation |
| Real-time push | WebSockets/SSE + pub/sub backplane (Redis) | connection state, scaling sockets horizontally |

Scaling patterns: stateless app tier + horizontal scaling; cache-aside; read replicas; **CQRS** read models; sharding by tenant/user; async processing; **consistent hashing** (adding or removing a node moves only ~1/N of the keys); back-pressure and load shedding.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`GetOrLoadOptions`](../../packages/backend/libs/infrastructure/cache/cache.service.ts#L26): GetOrLoadOptions configures cache TTL, stale-while-revalidate and negative caching for the cache building block. _(cache.service.ts)_
> - [Hand out ids in blocks of 1,000 from Redis](../../docs/humans/concepts/domain-marketing/id-lease.md): IdLease leases blocks of 1,000 sequential IDs from Redis to reduce database pressure. [`IdLease`](../../packages/backend/libs/domains/marketing/infra/id-lease.ts#L9)
> - [Publishing salted click records to Kafka](../../docs/humans/concepts/domain-marketing/click-publishing.md): Click records are published to Kafka with a random salt 0–9 on the campaign key to spread viral traffic across 10 partitions. [`click`](../../packages/backend/libs/domains/marketing/application/ads.service.ts#L9)
<!-- theory-links:end -->

---

## 4. Non-functional checklist (say it out loud at the end)

- **Scalability**: what grows (users, data, QPS) and where it breaks first.
- **Availability**: SLO, redundancy (multi-AZ), failure of each component → what happens?
- **Consistency**: which invariants are strong, and which data is eventually consistent?
- **Latency**: the hot path, caching, precomputation.
- **Durability**: backups, RPO/RTO.
- **Security**: authN/authZ, tenant isolation, PII encryption, audit logs.
- **Observability**: SLIs, alerts, tracing.
- **Cost**: biggest cost drivers.
- **Operability**: deploys, migrations, runbooks.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`SloDefinition`](../../packages/backend/libs/common/telemetry/slo-rules.ts#L12): SloDefinition models availability and latency SLOs with objectives and k6 thresholds. _(slo-rules.ts)_ · [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md)
> - [`sloRuleGroup`](../../packages/backend/libs/common/telemetry/slo-rules.ts#L55): sloRuleGroup generates Prometheus multi-burn-rate alert rules from each SLO. _(slo-rules.ts)_ · [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md)
> - [PostgreSQL advisory lock to serialize concurrent attempts](../../docs/humans/concepts/domain-payments/settlement-advisory-lock.md): A PostgreSQL advisory lock serializes concurrent settlement of the same order, preserving the strong consistency invariant. [`SettlementListener`](../../packages/backend/libs/domains/payments/infra/settlement.listener.ts#L23)
<!-- theory-links:end -->

---

## 5. Common mistakes
- Jumping into a design without requirements or numbers.
- Over-engineering (microservices, Kafka, sharding) for 50 QPS.
- Ignoring the data model, which is usually the heart of the problem.
- Never mentioning failure handling, idempotency, or retries.
- Monologuing without checking in with the interviewer.
- Hand-waving "the cache makes it fast" without covering invalidation and stampedes.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [UNKNOWN status: provider call timed out](../../docs/humans/concepts/domain-payments/unknown-status.md): UNKNOWN status models a timed-out Stripe call, handling failure explicitly rather than ignoring it. [`PaymentStatus`](../../packages/backend/libs/domains/payments/infra/models/payment.model.ts#L33), [`Payment`](../../packages/backend/libs/domains/payments/infra/models/payment.model.ts#L23)
> - [Resolving payments stuck in UNKNOWN](../../docs/humans/concepts/domain-payments/resolving-unknown-payments.md): A scheduled job resolves payments stuck in UNKNOWN by querying Stripe by idempotency key, covering retries and idempotency. [`PaymentResolutionJobs`](../../packages/backend/libs/domains/payments/infra/payment-resolution.jobs.ts#L29)
> - [Kafka send that is not awaited and ignores errors](../../docs/humans/concepts/domain-marketing/fire-and-forget-send.md): recordClick sends the Kafka event without awaiting it and ignores failures, so the redirect never waits on Kafka. [`recordClick`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts#L107)
<!-- theory-links:end -->
