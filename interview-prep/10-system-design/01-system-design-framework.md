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
- A single Postgres primary on good hardware: thousands to tens of thousands of simple QPS. Redis: ~100k+ ops/s per node. A Node process: roughly 1–10k simple req/s depending on the work.

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
