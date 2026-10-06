# Design: Payment Reliability, OCC, and Search-Made-Real

**Date:** 2026-08-09
**Status:** Approved for planning
**Roadmap source:** `docs/superpowers/plans/2026-08-02-feature-roadmap.md`

## Summary

This spec bundles roadmap Chunk A (payment reliability), the write-path half of Chunk B
(OCC), a slice of Chunk C (edge rate limiting, contracts), and the indexing half of
Chunk D (search-made-real) into one architectural pass. They're bundled because they
share one mechanism — the outbox mailman — and one consequence — the backend splits
into three deployable apps to isolate sync reads, async processing, and realtime
push from each other.

**Covers roadmap features:** #1, #5, #6 (OCC + minimal instance of #8), #9, #12
(partial — payload contracts, not full contract tests), #13–16 (indexing only, not
#17 embeddings), #19 (already done, unchanged), #20, #24.

**Explicitly deferred:** #7 CQRS read-model beyond ES, #8 as a general multi-step saga
orchestrator (this spec only implements the pay→reserve→refund instance forced by
OCC), #10/#11 pagination & partitioning (Chunk G), #17 semantic embeddings, #18 graph
recommendations, #21–23 caching (Chunk E), #25–28 ClickHouse (Chunk I).

---

## Architecture

```
Browser
  │
  ▼
Cloudflare Worker (edge-be)
  ├─ async writes ──► Kafka (payments.requests, Avro via Redpanda REST proxy)
  └─ sync reads  ──► proxied to apps/api (search, payment status, SSE)
  Both paths: Redis-backed rate limit (reuses existing Upstash REST connection)

apps/worker (no HTTP, Kafka + cron only)
  ├─ payment-processor consumer: Stripe (behind circuit breaker) → stock
  │   pre-check → OCC decrement → ledger → Outbox row, all one Postgres tx
  ├─ OutboxPublisherService (the mailman): drains Outbox → Kafka, topic-agnostic
  └─ search-indexer consumer: batches products.events → ES /_bulk

apps/realtime (SSE only)
  └─ realtime-notifier consumer: payments.responses/dlq → Redis pub/sub → SSE

apps/api (sync HTTP only)
  ├─ GET /products/search (existing, unchanged)
  ├─ POST /products (new — create + outbox row)
  └─ GET /payment/:id, GET /payment (existing, unchanged)
```

Module ownership is a target for the implementation plan to work out file-by-file;
this spec fixes the boundaries (what runs where, what talks to what), not the exact
Nest monorepo folder layout.

---

## 1. Workspace split

Nest's monorepo mode (`nest generate app`) splits `backend/` into three deployables
sharing one `node_modules` and a common library area (models, `api-config`,
`error.types`, `db-utils`) via existing path aliases:

| App | Responsibility | Has HTTP port? | Has Kafka consumer? |
|---|---|---|---|
| `apps/api` | Sync reads: product search, payment status, product create | Yes | No |
| `apps/worker` | Stripe, OCC, ledger, outbox mailman, product-search indexing | Health check only | Yes (`payment-processor`, `search-indexer`) |
| `apps/realtime` | SSE bridge | Yes (SSE only) | Yes (`realtime-notifier`) |

`apps/api` never talks to Kafka directly — it only writes Postgres rows (including
Outbox rows), same as the rest of the system; the mailman is the only thing that
ever touches a Kafka producer.

---

## 2. Edge worker (`edge-be`)

Two changes to `edge-be/src/index.ts`, both additive to the existing fetch handler:

**a. Proxy sync reads to `apps/api`.** Requests that aren't the async payment-accept
path (`/products/search`, `/payment/:id`, `/payment/stream`) are forwarded to
`apps/api`'s origin and the response is relayed back verbatim. For this pass the
proxy is transparent (no edge-side caching) — it exists so the edge is the single
ingress applying auth and rate limiting uniformly across both the async write path
and the sync read path, per roadmap #19/#20.

**b. Rate limiting.** Before either forwarding to Kafka or proxying to `apps/api`,
check a Redis fixed-window counter keyed by authenticated user (falling back to IP
for anonymous search): `INCR ratelimit:{key}:{windowStart}` with `EXPIRE` set to the
window length; reject with 429 over the limit. Reuses the same
`UPSTASH_REDIS_REST_URL` connection the edge already uses for idempotency locking —
no new infrastructure. Fixed-window is intentionally simpler than a token bucket;
it's enough to prove the roadmap's stated done-when ("rate limits survive multiple
edge instances").

**c. Kafka payload changes.** The `payments.requests` body gains `productId` and
`quantity` fields (see §5). The edge's existing `isConfluent` branch already builds
a JSON body per broker type — this pass adds the Avro content-type header for the
Redpanda branch (see §3) without changing the branching logic itself.

---

## 3. Schema registry (contracts)

Redpanda ships a Confluent-API-compatible Schema Registry in the same binary — add
`--schema-registry-addr internal://0.0.0.0:8081,external://0.0.0.0:18081` (or
similar) to the existing `redpanda start` command in `backend/docker-compose.yaml`.
No new container.

- **Edge → Kafka:** stays a plain `fetch()`. The only change is the `Content-Type`
  header on the Pandaproxy call: `application/vnd.kafka.avro.v2+json` instead of
  `application/vnd.kafka.json.v2+json`, plus the JSON body embedding a
  `value_schema` (or `value_schema_id` once registered). Redpanda itself talks to
  the registry, encodes to Avro, and writes the binary record — no Avro/Protobuf
  library ever runs inside the Workers runtime.
- **`apps/worker` → Kafka:** already-present `kafkajs` (`package.json:70`) plus the
  new `@confluentinc/schemaregistry` dependency decodes the binary payload back
  into JSON on consume.
- **One-time setup:** the Avro schema for each topic must be registered with the
  registry before the edge's first POST with that content-type succeeds — add a
  `kafka:schemas:register` script alongside the existing `kafka:topics:init`,
  wired into `infra:setup`.
- Schema evolution (adding `productId`/`quantity` to the payment request schema) is
  `BACKWARD` compatible: new fields, not removed ones.

---

## 4. Outbox mailman

**Migration** (new file in `backend/migrations/`): add to `Outbox`
- `publishedAt` — nullable timestamp
- `attempts` — integer, default 0
- `nextAttemptAt` — nullable timestamp, default `NOW()` (immediately eligible)
- partial index on `nextAttemptAt` `WHERE "publishedAt" IS NULL`
- extend the `topic` enum (`KafkaTopicGroup`) with `PRODUCTS_EVENTS = 'products.events'`

**`OutboxPublisherService`** (new, lives in `apps/worker`, driven by the existing
`@nestjs/schedule` cron already in the dependency list): every ~2s,
`SELECT ... FOR UPDATE SKIP LOCKED LIMIT 50` unpublished + due rows — safe across
multiple `apps/worker` replicas draining concurrently, no double-publish. Each row
is sent to Kafka via a small `KafkaProducerService` (`kafkajs`, reusing the
broker/SASL config already in `main.ts`); on success, set `publishedAt`; on failure,
increment `attempts` and set `nextAttemptAt = now + backoff(attempts) ± jitter`.
Topic-agnostic by design — it doesn't inspect payload shape, so it drains
`payments.responses`, `payments.dlq`, and the new `products.events` identically.

**Failure mode acknowledged, not hidden:** a crash between the Kafka publish
succeeding and the `publishedAt` commit produces a duplicate publish on restart.
This is why every consumer of these topics (search-indexer, realtime-notifier) must
be idempotent on the event's own id, not rely on at-most-once delivery.

---

## 5. Payment processing changes

All changes land inside the existing `PaymentService.executePayment`
(`backend/src/payment/payment.service.ts`), specifically the second
`wrapInTransaction` block ("Finalize Transaction", lines 142–237) — that block is
already one atomic Postgres transaction that runs *after* Stripe has been called,
which is exactly where a stock decrement needs to live.

**a. Request schema.** `PostPaymentParamsDto` gains `productId` (UUID, optional) and
`quantity` (number, default 1) — flat on the request, matching how `amount` is
already passed directly rather than derived from `BisOrder`. `Payment` gains the
same two columns, `productId` nullable (migration), persisted for every payment
that has one: not speculative — #18 (purchase-graph recommendations) already needs
"which product did this payment buy," so this is a concrete future dependency, not
YAGNI. `productId` is optional because non-product payment flows already exist in
this codebase (e.g. `StripeService.createIdentitySession`'s verification payment) —
when it's absent, the payment proceeds exactly as it does today (Stripe → ledger →
`COMPLETED`), and §5c/§5d (pre-check, OCC decrement) are skipped entirely.

**b. Circuit breaker.** Wrap `StripeService.createPaymentIntent` with `opossum`
(`errorThresholdPercentage: 50`, `resetTimeout: 10s`). When open, the call fails
fast with a new `Domain_CircuitBreakerOpenError` (same shape as the existing
`Domain_StripePaymentFailed` in `payment/types.ts` — `ErrorArea.DOMAIN`, so it flows
through `outboxService.notify()` normally rather than the retry/DLQ path in
`OutboxService.wrapInOutbox`).

**c. Stock pre-check (optimization, not correctness).** Before calling Stripe, a
plain uncached read — `SELECT quantity FROM "Product" WHERE id = :productId` — fails
fast with `Domain_InsufficientStockError` if stock is obviously gone. This is purely
to avoid an unnecessary Stripe charge+refund round-trip in the common (non-racing)
case. It provides no concurrency guarantee by itself.

**d. OCC decrement (the actual guarantee).** Inside the Finalize Transaction block,
after a successful Stripe response:

```sql
UPDATE "Product" SET quantity = quantity - :qty, version = version + 1
WHERE id = :productId AND version = :expectedVersion AND quantity >= :qty;
```

If this updates 0 rows, two requests raced past the pre-check and both charged
Stripe — the transaction commits *without* writing a ledger entry and *without*
flipping `Payment` to `COMPLETED` (it stays `PENDING`, deliberately — see below).

**e. Refund-on-conflict.** Outside any open DB transaction (mirroring the existing
principle at line 126–130 — "we call Stripe without holding a DB connection
captive"), issue a Stripe refund for the just-created PaymentIntent, using a fixed
idempotency key derived from the payment's own idempotency key (Stripe supports
idempotent refunds the same way it supports idempotent charges). Only *after* the
refund call itself succeeds does a short follow-up transaction mark `Payment` as
`REFUNDED` (existing enum value, previously unused — `payment.model.ts:26`) and
write the Outbox row with `Domain_InsufficientStockError`.

Leaving `Payment` at `PENDING` until the refund is confirmed is intentional: if the
process crashes between detecting the OCC conflict and completing the refund, Kafka
redelivery re-enters `executePayment`, re-calls Stripe (idempotent — returns the
cached succeeded intent, no double charge), re-attempts the OCC decrement (still
conflicts), and re-attempts the refund (idempotent — no double refund). The same
idempotency-key discipline that already protects the charge protects the refund,
with no new machinery.

**Updated done-when for #6** (supersedes the roadmap's original "412 on conflict,"
written for a synchronous endpoint that no longer applies to this async flow): two
concurrent buy-last-unit payment events → one `COMPLETED` with stock decremented,
the other `REFUNDED` with a real Stripe refund call, both outcomes visible to their
respective clients over SSE. No negative stock possible.

---

## 6. Product create endpoint

New `POST /products` in `apps/api`: validates and writes a `Product` row and an
Outbox row (`topic: PRODUCTS_EVENTS`) in one transaction. No Kafka consumer needed
here — the mailman picks up the Outbox row same as any other. Kept intentionally
minimal (create only); update/delete are out of scope for this pass.

---

## 7. Dual Kafka consumers

Both are new consumer groups reading topics the mailman just started actually
publishing to — this is the direct payoff of §4.

**`realtime-notifier`** (`apps/realtime`, plain `kafkajs`, separate group from
`payment-processor`): reads `payments.responses`/`payments.dlq`, republishes
`{ idempotencyKey, status, paymentId?, error? }` onto a Redis pub/sub channel named
per idempotency key.

**`search-indexer`** (`apps/worker`): reads `products.events` using `kafkajs`'s
`eachBatch`, maps the batch into a single NDJSON payload, and issues one HTTP
request to Elasticsearch's `/_bulk` API — built to survive load-test-level bursts
without one HTTP round-trip per product.

---

## 8. Realtime (SSE)

New `GET /payment/stream?idempotencyKey=...` in `apps/realtime` (`@Sse()`, behind
`Firewall`). Subscribes to the Redis pub/sub channel for that idempotency key and
streams matching events to the browser. Scoping note: unlike `GET /payment/:id`
(scoped by an existing owned Payment row), the stream may be opened before a
`Payment` row exists yet (client asks status immediately after the edge accepts the
request). The endpoint trusts the idempotency key's ownership was already
established at the edge (same JWT-scoped mechanism that already gates the
idempotency lock), and once a `Payment` row appears it re-validates that the
requesting user actually owns it before relaying further events.

---

## Migrations

1. `Outbox`: add `publishedAt`, `attempts`, `nextAttemptAt` + partial index; extend
   `topic` enum with `products.events`.
2. `Payment`: add `productId` (UUID, nullable FK → `Product`), `quantity` (integer,
   default 1).

## New dependencies

- `opossum` — circuit breaker
- `ioredis` — Redis pub/sub (realtime bridge; reuses the existing Redis container)
- `@confluentinc/schemaregistry` — Avro decode in `apps/worker`/`apps/api`
- (edge-be: no new dependency — stays a plain `fetch()`)

## Done-when, by feature

| # | Feature | Done when |
|---|---|---|
| 1 | Outbox / fault tolerance | Kill Kafka mid-load-test → Outbox rows pile up with `publishedAt IS NULL` → restart Kafka → mailman drains backlog → SSE client sees final status. |
| 5 | Async command path | Edge accept response includes idempotency key; client receives a terminal status over SSE without polling. |
| 6 | OCC | Two concurrent buy-last-unit events → exactly one `COMPLETED`, one `REFUNDED` (real Stripe refund); no negative stock. |
| 9 | Circuit breaker | Force Stripe errors (existing `is_load_test` hook) past the error threshold → breaker opens → subsequent payments fail fast, no hung requests. |
| 13–16 | Search | Seeded + created products are indexed within ~1s; typo search, autocomplete, filters all return real results. |
| 20 | Rate limiting | Bad traffic gets 429s consistently across multiple edge instances, on both the Kafka-publish and proxied-read paths. |
| 24 | Realtime push | Payment status changes arrive over SSE without the client polling `GET /payment/:id`. |

## Out of scope for this pass

- Full saga orchestrator (#8 beyond the pay→reserve→refund instance forced by OCC)
- Semantic embeddings (#17)
- Graph recommendations (#18)
- Caching (Chunk E), pagination/partitioning (Chunk G), ClickHouse (Chunk I)
- Edge-side caching on the proxied read path (transparent proxy for now)

## Follow-ups (noted, not yet done)

- **Give `search-indexer` its own deployable, not `core`.** Its `eachBatch` consumer accumulates a window of events (~2-5s) before doing one bulk ES write — a genuinely different processing-latency profile than the rest of `core`'s fast request/response work. By the same real-forcing-reason rule used to split out `payment-processor` (Stripe latency) and `sse-gateway` (connection-count profile), batched/delayed processing is its own legitimate axis and `search-indexer` shouldn't be lumped into `core` just because it had no HTTP surface of its own.
- **Generalize `search-indexer` beyond products.** Right now it only syncs `Product` rows into the `products` ES index. Worth reshaping into a generic Postgres→Elasticsearch sync utility (topic → table/index mapping configurable) so any future entity needing search/read-model sync doesn't need its own bespoke consumer.
- **Move `PaymentQueryModule` into `libs/common`.** It currently lives app-local under `apps/core/src/payment-query`; it's a reusable DTO-backed read concern like the rest of `libs/common`'s `*-dto` modules, not something core-specific.
