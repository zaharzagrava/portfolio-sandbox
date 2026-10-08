# Feature Specification: S53 — Domain Events, Outbox/CDC → Kafka, Idempotent Versioned Projections, Replay, Read-Your-Writes (domain `infrastructure`)

**Feature Branch**: `S53-events-projections` (spec directory `specs/domains/S53-events-projections`)

**Created**: 2026-10-06

**Status**: Draft

**Input**: Capability S53 of `scripts/sdd/capabilities.tsv`. Sources: `docs/showcase/sections/F-05-cqrs-projection-framework.md`, `interview-prep/06-distributed-systems/01-messaging-queues-kafka-sqs.md` (§1 queue vs log, §2 delivery semantics, idempotent producer, Kafka transactions, §3 SQS, §4 Kafka and consumer groups, §5 dual write, outbox and inbox, §6 ordering, §7 event design, §8 backpressure, Q&A). Pattern-map rows covered: **P0111**, **P0112**, **P0317**, **P0322**, **P0408**, **P0413**, **P0601**, **P0603**, **P0605**, **P0606**, **P0607**, **P0608**, **P0609**, **P0706** (see the coverage table at the end of Requirements).

## Scope

The **event backbone** is the one shared library through which a domain says "this happened" and every other domain reacts, without ever sharing a table. It is a tool, not a store of business truth: it owns no business data, it never reads a domain's tables, and every read model it feeds can be rebuilt from the log.

In scope:

- **Event contract**: the envelope every event carries, typed event definitions with validated payloads, per-aggregate topics, and versioning rules (additive within a version, a new version for a breaking change).
- **Transactional outbox**: appending an event (or a single-consumer task) in the same transaction as the state change; a framework-free append for non-Nest writers (Lambda, the Rust gateway).
- **Relay to the log**: a poller (default) and log-based change data capture (CDC) of the outbox table only, both publishing the same message, at least once, in per-aggregate order, with bounded retries and parking.
- **Plain producer**: a keyed, idempotent, time-boxed send for events that have no SQL transaction to be atomic with.
- **Consumer framework** (hosted in `apps/projector` or `apps/worker`): one consumer group per consumer, envelope and payload validation, declared idempotency mechanism (inbox, version guard or natural), coalescing, retries with backoff, dead-lettering with reason codes, backpressure, graceful stop, lag metric.
- **Inbox service**: the one way to record "this external or internal message was already handled", including inbound webhooks.
- **Versioned sinks**: version-guarded writes to Redis, Elasticsearch, DynamoDB, Cassandra/Scylla and ClickHouse; the pure version-guard decision for domain-owned tables.
- **Read-your-writes**: checkpoints of what each read model has applied, and a helper that waits briefly, then falls back to the write model or answers "still processing".
- **Replay and rebuild**: in-place replay, zero-downtime shadow rebuild with a promotion gate and rollback, lag and watermark reads, DLQ redrive.
- **Single-consumer tasks**: the task queue port (delay, FIFO group, dedupe, visibility timeout, dead-letter) and the outbox-to-queue relay, because "fan-out to many" and "do this once" are two halves of the same decision (P0601).
- **Kafka transactions**: consume-transform-produce with offsets committed atomically (P0603).
- **Observability**: metrics, spans and logs for all of the above.

Out of scope (owned elsewhere; named so nothing is built twice):

- The meaning of any event or read model: names, payload fields, topics' business purpose, projector logic. The producing domain owns the event contract (`@app/domains/<d>` entry point, schemas in `packages/contracts`); the consuming domain owns its consumer and its read model. Each states how it uses this capability.
- The `Idempotency-Key` HTTP facility for `POST` routes (replay, in-flight `409`, different-body `422`, TTL) → first specified in **S10**, platform part **S54**. The inbox here is a different thing: it de-duplicates messages, not client requests.
- Lambda event-source mapping and its partial-batch response format → **S55**. The task queue port here exposes the per-message outcome that S55's adapter maps.
- Health probes, the problem+json filter, the clock, config validation, the metrics registry, shutdown ordering, request context and the transaction runner → **S54**. Single-run scheduling of the purge jobs → **S49**. The outbox poller itself is **not** a scheduled job: it runs on every replica on a local ticker (S49 FR-060). Cache invalidation called from consumers → **S52**. Realtime fan-out → **S51**.
- The generic Elasticsearch client (split from the product-index adapter, debt D-16) → **S32**.
- No domain table is read or written by this capability. It owns exactly two technical tables of the constitution IX.3 allowlist: the **outbox** and the **inbox / processed-events** table. Cross-domain data appears only as the IX.7 mechanisms named below: **R1** (an exported-service fallback supplied by the caller for read-your-writes) and **R3** (this capability *is* the R3 machinery: outbox → topic keyed by aggregate ID → idempotent versioned projector → read model owned by the consumer). **R2** is not used.

## User Scenarios & Testing *(mandatory)*

Actors: **a domain developer** (appends events, writes a consumer, reads with `minVersion`), **an end user** (writes something and reads it back), **an operator** (watches lag and backlog, redrives dead letters, rebuilds a read model), **another instance** (a second process of the same deployment), **a non-Nest writer** (Lambda, Rust gateway), **the broker and stores** (fail, hang, slow down).

Notation: the **log** is the event log (Kafka-compatible). An **aggregate** is the unit that owns a sequence of changes (an order, a product); its **aggregate version** (`aggregateVersion`) is its state version after the change. An **event** has a `type` (such as `orders.order_paid`) and a contract `version` (such as 1). A **consumer** is anything that reads the log with its own consumer group (a projector is a consumer that writes a read model). **Effect** is whatever a consumer changes (a row, a document, a cache key, an e-mail request). The clock, the random source and the broker/store failures are injected in tests. Numbers (256 KiB, 30 s, 10 attempts, 500 ms) are the defaults of this spec (see Assumptions); each is configurable and validated at startup.

### User Story 1 — A state change and its event commit together or not at all (Priority: P1)

A domain developer changes an order and must announce `order_paid`. If the announcement is a separate write, a crash between the two loses it or announces something that never committed. Appending the event inside the same transaction removes both failures. A Lambda or the Rust chat gateway, which are not Nest services, need the same guarantee.

**Why this priority**: every other story assumes events are never lost and never phantom.

**Independent Test**: a fixture aggregate service changes state and appends events in one transaction; commit and rollback are observed in the state table and the outbox.

**Acceptance Scenarios**:

1. **AS-01 (commit)** — **Given** a fixture aggregate `A` at version 3 and a registered aggregate type `fixtures`, **When** a transaction updates `A` to version 4 and appends `fixtures.item_changed` (contract version 1, payload valid) and commits, **Then** `A` is at version 4 and exactly one pending outbox row exists with topic `fixtures.events`, key `A`, and envelope `{eventId (UUIDv7), type: 'fixtures.item_changed', version: 1, aggregateType: 'fixtures', aggregateId: A, aggregateVersion: 4, occurredAt (the injected clock, ISO 8601 UTC), traceparent (of the active span), payload}`.
2. **AS-02 (rollback)** — **Given** the same setup, **When** the transaction appends the event and then fails and rolls back, **Then** `A` is still at version 3, the outbox has zero rows, and nothing is ever published.
3. **AS-03 (no transaction)** — **When** `append` is called with no active transaction, **Then** it rejects with `NoActiveTransactionError`, writes no row, and the error names the event type. **When** `appendStandalone` is called with the same event (an event with no state change of its own, such as `search.reindex_completed`), **Then** exactly one row is written atomically in its own short transaction.
4. **AS-04 (invalid payload)** — **When** an event is created with a payload that fails its schema (missing required field, wrong type), **Then** creation throws `InvalidEventPayloadError` naming the first failing path (not the value), nothing is appended, and the caller's transaction is not silently committed (the error propagates).
5. **AS-05 (several events)** — **When** one transaction appends three events for two aggregates and commits, **Then** three rows exist, written by one statement, and after the relay runs each aggregate's events appear in the log in append order.
6. **AS-06 (concurrent writers)** — **Given** `A` at version 3, **When** two transactions run with `Promise.all`, each doing the aggregate's conditional update `version = 3 → 4` and appending `fixtures.item_changed` with `aggregateVersion: 4`, **Then** exactly one commits, the other fails with the aggregate's conflict error and rolls back, and the outbox holds exactly one row for `aggregateVersion: 4`.
7. **AS-07 (size limit)** — **When** an event whose serialized envelope exceeds 256 KiB is created, **Then** it throws `EventTooLargeError` (limit and actual size in the message), and nothing is appended.
8. **AS-08 (non-Nest writer)** — **Given** a writer that has only a database connection and an open transaction (the Lambda of S29, the Rust gateway of S24), **When** it appends through the framework-free append (or inserts a row that follows the documented row contract), **Then** the row is relayed exactly like AS-13, and a row that violates the contract (empty aggregate ID, unregistered shape) is rejected by the database at insert time.
9. **AS-09 (table isolation)** — **When** the static ownership check runs over all domains, **Then** no domain code issues SQL, injects a model, or associates with the outbox or inbox tables; the only access is through this capability's exported services (IX.6).
10. **AS-10 (definition rules)** — **When** an event definition is registered with a type that is not lowercase dotted `a.b_c`, with a duplicate `(type, version)`, or when `aggregateVersion` is negative, fractional or above 2^53−1, **Then** registration (or creation) fails with a typed error and no event is created.
11. **AS-11 (topic registry)** — **Given** domains register their aggregate types at module start (`aggregateType`, partitions, retention policy), **When** an event for an unregistered aggregate type is appended, **Then** it throws `UnregisteredAggregateTypeError` and nothing is written; **When** the type is registered, **Then** the event goes to `<aggregateType>.events`. No central list of domain topics exists in this capability.
12. **AS-12 (compaction rule)** — **When** a topic is registered with retention policy `latest-per-key` but one of its event definitions is not marked as carrying the full aggregate state, **Then** registration fails at startup with `TopicPolicyError` naming the event type.

---

### User Story 2 — Events reach the log reliably, once at least, in per-aggregate order (Priority: P1)

An operator needs the promise "every committed event is published, never lost, never published for a rolled-back change, in order per aggregate" to hold through broker outages, relay crashes and two relays running at once. Where change data capture is deployed, the log must contain the same messages as the poller would produce.

**Why this priority**: it is the dual-write answer (constitution IV.4).

**Independent Test**: seed outbox rows through the real append, run the relay against a real log, inject broker faults, read the topic.

**Acceptance Scenarios**:

1. **AS-13 (message shape)** — **Given** three pending rows, **When** the relay drains, **Then** each message is on the row's topic, keyed by `aggregateId`, its value is exactly the envelope JSON (no wrapper object), its headers carry `eventId`, `type`, `version` and `traceparent`, and each row is marked published with a timestamp.
2. **AS-14 (broker down)** — **Given** the broker is unreachable, **When** the relay drains two rows, **Then** both stay unpublished, `attempts` is 1, `nextAttemptAt` lies in the future by a full-jitter backoff between 0 and `min(60 s, 1 s × 2^attempts)`, and no row is lost; **When** the broker returns and the rows are due, **Then** each is published once.
3. **AS-15 (crash after publish)** — **Given** the publish succeeds but marking the row fails (simulated crash), **When** the lease expires and the relay drains again, **Then** the log holds two messages with the same `eventId`, key and partition (at-least-once), and the row ends published; consumers de-duplicate (AS-28 to AS-30).
4. **AS-16 (two relays)** — **Given** 100 pending rows and two relay instances, **When** both drain at once (`Promise.all`), **Then** each row is claimed by exactly one instance and the log holds exactly 100 messages with no duplicate `eventId`.
5. **AS-17 (per-aggregate order)** — **Given** pending rows `A1, A2, A3` for aggregate A and `B1` for aggregate B, **When** `A1` fails to publish (injected) in a drain, **Then** `A2` and `A3` are not published in that drain, `B1` is; **When** `A1` later succeeds, **Then** `A2` and `A3` follow, and the log shows `A1, A2, A3` in that order for key A.
6. **AS-18 (bounded retries and parking)** — **Given** a row that fails every attempt, **When** it reaches 10 failed attempts, **Then** it is parked (no further attempts), the metric `outbox_parked` is 1, one error log line names the row ID and error class (no payload), and later rows of the same aggregate are published again (a parked row no longer blocks). **When** an operator requeues it, **Then** it returns to pending with `attempts` 0.
7. **AS-19 (non-retryable)** — **Given** a row whose message the broker rejects as invalid or too large, **When** it is attempted, **Then** it is parked immediately with reason `NON_RETRYABLE` (no backoff cycle), while a timeout or connection reset follows AS-14.
8. **AS-20 (lease)** — **Given** a relay that claimed 50 rows and crashed, **When** 29 s pass, **Then** other relays do not see them; **When** 31 s pass, **Then** they are claimable again and are published.
9. **AS-21 (CDC equivalence)** — **Given** the relay mode is `cdc` and the CDC connector runs, **When** the same row is written, **Then** the poller does not start, and the message on the log has the same topic, key, value and headers as AS-13.
10. **AS-22 (CDC reads only the outbox)** — **When** the connector configuration shipped with the repository is inspected, **Then** its include list is exactly the outbox table and it routes by the row's topic and keys by aggregate ID.
11. **AS-23 (mode validation)** — **When** the application starts with a relay mode other than `poller` or `cdc`, **Then** startup fails with a message naming the setting; in `poller` mode exactly one poller runs per process.
12. **AS-24 (retention)** — **Given** published rows older than 7 days, unpublished rows and parked rows of the same age, **When** the purge job runs, **Then** only the published rows are deleted, in batches of at most 1,000 rows, a second run deletes nothing more, and the job is registered as a single-run job (S49).
13. **AS-25 (plain producer)** — **When** an event is sent through the plain producer, **Then** it is validated against the envelope contract before sending, keyed by `aggregateId`, sent with acknowledgement from all in-sync replicas and the idempotent-producer setting, and touches no database; **When** the broker hangs, **Then** the call rejects with `PublishTimeoutError` within 10 s plus 1 s; **When** the envelope is invalid, **Then** nothing is sent.
14. **AS-26 (idempotent producer)** — **Given** the broker's acknowledgement of the first send is dropped by a fault proxy, **When** the producer retries, **Then** the topic holds exactly one copy of that message.
15. **AS-27 (trace propagation)** — **Given** an active span at `append`, **When** the event is relayed and consumed, **Then** the consumer's processing span has the same trace ID as the span active at `append` (carried by `traceparent`).

---

### User Story 3 — A consumer's effect happens once, whatever the delivery (Priority: P1)

A consumer sees the same event twice (producer retry, relay crash, rebalance, redelivery) and sees events out of order (retries, parallel instances). The developer must declare how the consumer copes, and the framework must make each mechanism work: an inbox record in the same transaction, a version guard, or a naturally idempotent operation.

**Why this priority**: "effectively once" is at-least-once delivery plus idempotent consumers (notes §2); every capability's consumer depends on it.

**Independent Test**: fixture consumers, one per mechanism, receive real envelopes from a real log; effects are read back.

**Acceptance Scenarios**:

1. **AS-28 (duplicate, inbox)** — **Given** an inbox consumer that inserts a row, **When** the same event (same `eventId`) is delivered twice, **Then** exactly one row exists, exactly one inbox record `(consumer, eventId)` exists, and the second delivery is counted `duplicate`.
2. **AS-29 (duplicate, version guard)** — **Given** a version-guarded consumer, **When** the same event is delivered twice, and when a second event with a different `eventId` but the same `aggregateVersion` and payload arrives, **Then** the read model is unchanged after the first application, one logical write happened, and the others are counted `duplicate`.
3. **AS-30 (duplicate, natural)** — **Given** a consumer declared `natural` (an upsert by business key), **When** an event is delivered twice, **Then** one row exists.
4. **AS-31 (inbox atomicity)** — **Given** an inbox consumer whose handler throws after writing its effect, **When** the event is delivered, **Then** neither the effect nor the inbox record persists; **When** it is redelivered and the handler succeeds, **Then** both exist once.
5. **AS-32 (concurrent duplicates)** — **Given** two instances of one consumer, **When** both process the same `eventId` at the same moment (`Promise.all`), **Then** exactly one effect and one inbox record exist, and the loser reports `duplicate` without error.
6. **AS-33 (out of order)** — **Given** events for aggregate A with `aggregateVersion` 3, 1, 2 delivered in that order, **When** the consumer processes them, **Then** the read model holds version 3, versions 1 and 2 are counted `stale`, and the checkpoint is 3.
7. **AS-34 (equal version)** — **Given** the read model at version 5, **When** another event for the same aggregate with `aggregateVersion` 5 arrives, **Then** it is counted `duplicate`, nothing is written, and the checkpoint stays 5.
8. **AS-35 (per-key sequence)** — **Given** 200 events over 10 aggregates in one partition, **When** the consumer processes them, **Then** for each aggregate the handler invocations never overlap and follow log order.
9. **AS-36 (redelivery after a throw)** — **Given** a handler that throws on the first delivery of event E, **When** the consumer retries, **Then** E is delivered again, applied once, and the committed offset passes E only after success.
10. **AS-37 (commit after effect)** — **Given** a handler blocked inside a batch, **When** the consumer connection is cut before the handler finishes, **Then** the committed offset is still before that batch, and after restart the batch is delivered again and applied once in effect; **When** the cut happens after the effect but before the commit, **Then** the event is redelivered and counted `duplicate`.
11. **AS-38 (rebalance)** — **Given** one consumer instance owns all partitions of a 6-partition topic, **When** a second instance of the same group joins during traffic, **Then** each partition is owned by exactly one instance, no partition is processed by two instances at once, and after 1,000 events every event has been applied exactly once in effect.
12. **AS-39 (fan-out)** — **Given** two consumers with different groups on one topic, **When** 10 events are published, **Then** each consumer receives all 10, and a failure or lag in one does not delay the other.
13. **AS-40 (coalescing)** — **Given** a consumer declared `coalesce` and 30 events for one aggregate (versions 1 to 30) in one batch, **When** it is processed, **Then** the handler receives one event (version 30), the checkpoint is 30, the lag metric counts all 30 events, and `consumer_events_total{outcome="coalesced"}` is 29; a consumer without `coalesce` receives all 30 in order.
14. **AS-41 (coalescing declaration)** — **When** a consumer declares `coalesce` on a topic that has an event type not marked as carrying the full aggregate state, **Then** startup fails with `ConsumerDeclarationError`.
15. **AS-42 (delete and resurrection)** — **Given** a state projection and events `deleted` at version 5 then a late `upsert` at version 4, **When** both are processed, **Then** the document stays deleted at version 5 (a versioned tombstone is kept); **When** an `upsert` at version 6 arrives, **Then** the document exists at version 6.
16. **AS-43 (declaration required)** — **When** a consumer is registered without a declared idempotency mechanism, or two consumers share a group name, **Then** startup fails with `ConsumerDeclarationError` naming the consumer.

---

### User Story 3b — The inbox service records "already handled" (Priority: P1)

Inbound webhooks and message consumers need one place to record that a message was handled, with a processing status, so retries by a provider or a broker are cheap and safe (constitution IV.5, V.8).

**Independent Test**: call the inbox service from fixture code against the real database.

**Acceptance Scenarios**:

1. **AS-44 (claim)** — **When** `claim('stripe', 'evt_1')` is called for a new pair, **Then** it returns `outcome: 'CLAIMED'`, status `RECEIVED`, attempts 1, and one row exists.
2. **AS-45 (concurrent claims)** — **When** two calls claim the same pair at once (`Promise.all`), **Then** exactly one returns `CLAIMED` and the other `DUPLICATE_IN_PROGRESS`; one row exists.
3. **AS-46 (terminal duplicates)** — **Given** a claim marked `PROCESSED`, `IGNORED`, `UNMATCHED` or `REJECTED`, **When** the pair is claimed again, **Then** `DUPLICATE_DONE` with that status is returned and nothing changes.
4. **AS-47 (failed and stale)** — **Given** a claim marked `FAILED`, **When** it is claimed again, **Then** `CLAIMED` with attempts 2; **Given** a claim still `RECEIVED` after the 5-minute claim lease (crash), **When** it is claimed again, **Then** `CLAIMED` with attempts incremented.
5. **AS-48 (purge)** — **Given** terminal rows older than 30 days and newer rows, **When** purge runs, **Then** only the old terminal rows are deleted, in batches of at most 1,000, and `RECEIVED` rows are never purged by age alone.
6. **AS-49 (in the caller's transaction)** — **When** `recordOnce(consumer, eventId)` is called inside a transaction that later rolls back, **Then** no record persists and a retry returns `true` again; inside a committed transaction a second call returns `false`.

---

### User Story 4 — Bad messages and sick stores do not stop the line (Priority: P1)

A malformed message, a payload that fails its schema, an unknown event, a handler bug, a saturated or down store: each must end differently. Poison goes to a dead-letter topic with a reason, without blocking the partition. A sick store pauses consumption instead of burning every event into the dead-letter topic (notes §8).

**Why this priority**: without it one bad message or one outage stops or empties a topic.

**Independent Test**: publish crafted bytes and envelopes; break the sink with a fault proxy; read the dead-letter topic.

**Acceptance Scenarios**:

1. **AS-50 (malformed)** — **When** the consumer receives invalid JSON, an empty value, or JSON that is not an envelope, **Then** each goes to `<group>.dlq` with reason code `INVALID_JSON` or `INVALID_ENVELOPE`, no effect happens, and the rest of the batch is applied.
2. **AS-51 (payload fails schema)** — **Given** a batch of 5 events where the third fails its payload schema, **When** it is processed, **Then** the third is dead-lettered with `SCHEMA_INVALID` and the paths that failed (never values), and events 1, 2, 4 and 5 are applied.
3. **AS-52 (unknown type)** — **When** an event of a type the consumer does not handle arrives on a subscribed topic, **Then** it is skipped (counted `ignored`), its offset is committed, and it is not dead-lettered.
4. **AS-53 (newer contract version)** — **When** an event of a known type with a `version` above the highest the consumer supports arrives, **Then** it is dead-lettered with `UNSUPPORTED_VERSION` and can be redriven after the consumer is upgraded (AS-62).
5. **AS-54 (older contract version)** — **Given** the consumer declares an upgrade from version 1 to version 2, **When** a version 1 event arrives, **Then** it is upgraded and applied as version 2 with the same effect as a native version 2.
6. **AS-55 (aggregate ID rule)** — **Given** a consumer that declares aggregate IDs are UUIDs, **When** an envelope with `aggregateId: "not-a-uuid"` arrives, **Then** it is dead-lettered with `INVALID_ENVELOPE` and no effect happens.
7. **AS-56 (dead-letter record)** — **When** any message is dead-lettered, **Then** the record holds the original key and value bytes unchanged and headers `x-source-topic`, `x-source-partition`, `x-source-offset`, `x-consumer`, `x-dlq-reason-code`, `x-dlq-reason` (at most 500 characters, built from error class and schema paths, never payload values), `x-attempts`, `x-failed-at`.
8. **AS-57 (permanent failure)** — **Given** event E whose handler always throws a permanent error, **When** the batch is processed, **Then** E is attempted 3 times with full-jitter backoff (200 ms base, 5 s cap), then dead-lettered with `HANDLER_FAILED`, other events in the partition are applied, and the offset passes E.
9. **AS-58 (attempt budget)** — **Given** a consumer configured for 6 attempts, **When** its handler fails permanently on E, **Then** the handler is invoked exactly 6 times before dead-lettering.
10. **AS-59 (transient failure pauses)** — **Given** the sink is unreachable for 30 s (fault proxy), **When** events arrive, **Then** the partition is paused and retried with backoff, no event is dead-lettered (`dlq_total` stays 0), and after the sink returns every event is applied in order.
11. **AS-60 (backpressure)** — **Given** a sink throwing `SinkBackpressureError(retryAfterMs: 2000)`, **When** it throws, **Then** that partition is paused for at least 2 s then resumed, other partitions keep flowing, and the batch is not counted as failed.
12. **AS-61 (bounded in flight)** — **Given** 5,000 events on one partition and a slow handler, **When** they are processed, **Then** at no moment more than 500 events are inside the handler.
13. **AS-62 (dead-letter unavailable)** — **Given** the dead-letter topic cannot be written, **When** a poison event is found, **Then** the batch's offset is not committed, the consumer retries, no event is dropped, and the metric `dlq_write_failures_total` increases.
14. **AS-63 (redrive)** — **Given** 4 dead-lettered messages, **When** an operator redrives the consumer's dead letters, **Then** each is republished to its source topic with the original key and an incremented `x-redriven-count`; a message already redriven 3 times is not redriven again; after the cause is fixed each is applied once.
15. **AS-64 (graceful stop)** — **When** the consumer is told to stop during a batch, **Then** the in-flight batch finishes, the committed offset equals the last applied offset plus one, the connection closes within 20 s, and nothing new is fetched.
16. **AS-65 (handler timeout)** — **Given** a handler that hangs, **When** 30 s pass, **Then** the attempt fails as transient, counts toward the attempt budget, and the group session stays alive (no rebalance caused by the hang).

---

### User Story 5 — A read model is never made older by a late event (Priority: P1)

A projector writes a read model in the store that suits the screen (search, cache, feed, analytics). Whatever arrives late, twice, or concurrently from two instances, the newest aggregate version wins and the same input always converges to the same state.

**Independent Test**: for each store, write versions in shuffled order from two writers and read the final state.

**Acceptance Scenarios**:

1. **AS-66 (Redis)** — **When** versions 5 and 6 are written by two racing writers (`Promise.all`, 200 repetitions) and then version 4, **Then** the final document is always version 6; version 6 written again is skipped.
2. **AS-67 (Elasticsearch)** — **When** version 3 then version 2 then version 3 are indexed for one ID, **Then** the document stays at version 3, a stale or equal write is a skipped outcome (not an error, not logged as a failure), and a bulk of 100 mixed versions applies exactly the newest per ID.
3. **AS-68 (DynamoDB)** — **When** version 3, 1 and 3 are put for one key, **Then** the item stays at version 3; a stale put returns "not applied" and is not an error.
4. **AS-69 (Cassandra / Scylla)** — **When** version 3 then 1 are written with the version as write timestamp, **Then** the row holds version 3; the table is written only by version-timestamped projector writes.
5. **AS-70 (ClickHouse)** — **When** the same batch is inserted twice, and when version 1 is inserted after version 2, **Then** after merge (read with `FINAL`) one row per key at version 2 exists, and the duplicate batch added no rows.
6. **AS-71 (guard decision)** — **When** the pure decision is asked for `(stored, incoming)` pairs, **Then** it answers `apply` for no stored version or a lower stored version, `duplicate` for equal, `stale` for a higher stored version; versions must be non-negative integers.
7. **AS-72 (partial sink failure)** — **Given** a batch of 10 events where the sink fails on the 4th write transiently, **When** the batch is retried, **Then** the final read model equals the result of applying all 10 once, and no duplicate effect exists.

---

### User Story 6 — A writer sees their own write (Priority: P1)

A seller saves a product and the next screen must show it, although the search or list read model is eventually consistent. The write returns the aggregate's `version`; the read accepts `minVersion` and waits briefly for the read model, then reads the write model or says "still processing". The same helper serves a lagging read replica.

**Why this priority**: it is the user-visible price of CQRS; without it "I saved it and it is not there".

**Independent Test**: a fixture module with a tenant-owned aggregate, a projector, a write route returning `version`, and a read route accepting `minVersion`, through `supertest`.

**Acceptance Scenarios**:

1. **AS-73 (already caught up)** — **Given** the read model at version 7, **When** the read route is called with `minVersion=7`, **Then** it answers `200` from the read model at once (no wait), with header `X-Read-Source: read-model`.
2. **AS-74 (catches up in the wait)** — **Given** the read model at version 6 and the projection applying version 7 after 200 ms, **When** the read route is called with `minVersion=7`, **Then** it answers `200` from the read model after about 200 ms (never more than the 500 ms budget) with version 7.
3. **AS-75 (fallback to the write model)** — **Given** the projection is stopped at version 6, **When** the read route is called with `minVersion=7`, **Then** after the 500 ms budget it answers `200` with the write model's data (version 7) and `X-Read-Source: write-model`, obtained through the owning domain's exported read (R1), scoped to the caller.
4. **AS-76 (still processing)** — **Given** the route is configured to answer "pending" instead of falling back, **When** the projection is behind, **Then** it answers `202` with `Retry-After: 1` and body `{ status: 'pending', requiredVersion: 7 }`.
5. **AS-77 (input validation)** — **When** `minVersion` is `-1`, `1.5`, `abc`, empty, repeated, or above 2^53−1, **Then** the route answers `400` problem+json naming the parameter and does not wait; **When** it is absent, **Then** no waiting happens.
6. **AS-78 (cross-tenant)** — **Given** an aggregate owned by tenant A, **When** tenant B reads it with `minVersion=1`, **Then** the answer is `404` identical in body shape to a non-existent ID, the checkpoint store is not consulted, and the response does not wait.
7. **AS-79 (checkpoint store down)** — **Given** the checkpoint store is unavailable, **When** the read route is called with `minVersion`, **Then** it answers from the write model immediately (no error, no wait) and the metric `read_your_writes_total{outcome="fallback", reason="checkpoint_unavailable"}` increases.
8. **AS-80 (checkpoints)** — **When** events with versions 7, 5, 9 are applied, **Then** the checkpoint reads 9 (only ever increases, recorded after the sink write, also for `duplicate` and `stale` outcomes), and each checkpoint entry expires 24 h after its last update, so memory is bounded by recent activity.
9. **AS-81 (wait logic)** — **Given** a probe function that returns the applied version, **When** the helper runs with a frozen clock and a probe that reaches `minVersion` at 300 ms, never, or throws, **Then** it returns `reached`, `timeout` (after exactly the budget, with jittered poll intervals that start at 10 ms and never exceed 100 ms) or `unavailable`; a requested budget above 2,000 ms is clamped to 2,000 ms. The probe may be a read replica's version instead of a checkpoint (P0317).

---

### User Story 7 — A read model can be rebuilt or replaced without downtime (Priority: P2)

An operator fixes a projector bug or changes an index mapping. The read model must be rebuilt from the log, either in place or into a shadow target that is promoted only when it has caught up, with the old one kept for rollback. Consumers that cause side effects (e-mail, webhooks) must not be rewound by accident.

**Independent Test**: fixture projector over a real log and store; rebuild commands run against it.

**Acceptance Scenarios**:

1. **AS-82 (in-place replay)** — **Given** a stopped consumer group with 1,000 applied events, **When** the rebuild command resets it to the earliest offset and the consumer restarts, **Then** every event is delivered again and the final read model is identical (same content hash) to before.
2. **AS-83 (active group refused)** — **Given** a group with a live member, **When** the rebuild command runs, **Then** it exits non-zero with `GROUP_ACTIVE`, and the committed offsets are unchanged.
3. **AS-84 (shadow rebuild, promotion gate)** — **Given** live version `v1` and a new version `v2` reading the same topics into a shadow target, **When** `promote` is asked while `v2`'s lag is above 1,000 events or its verification count differs from the source count, **Then** it refuses with `NOT_CAUGHT_UP` and reads still use `v1`; **When** `v2` has caught up and verification matches, **Then** promotion switches reads to `v2` atomically (no read ever sees a partial target) and `v1` is kept.
4. **AS-85 (rollback)** — **When** an operator rolls back after promotion, **Then** reads use `v1` again, and `v1` has kept applying events during the interval so it is not stale.
5. **AS-86 (resume)** — **Given** a replay stopped after 400 of 1,000 events, **When** it is started again, **Then** it continues from the committed offsets and does not start from zero; after completion every event is applied exactly once in effect.
6. **AS-87 (side-effect consumers)** — **Given** a consumer declared `replayable: false`, **When** a rebuild is requested without `--allow-side-effects` and a reason, **Then** it is refused with `NOT_REPLAYABLE`; with both, it proceeds and writes one audit log line (consumer, reason, operator).
7. **AS-88 (history truncated)** — **Given** the earliest retained offset of a topic is above 0 and the topic is not `latest-per-key`, **When** a rebuild from scratch is requested, **Then** it is refused with `HISTORY_TRUNCATED` unless `--from-retained` is given; **Given** a `latest-per-key` topic, **Then** the rebuild proceeds and the result holds the latest state of every aggregate (including versioned deletes).
8. **AS-89 (lag and watermark)** — **When** 100 events are published and a consumer has applied 60, **Then** `ConsumerLag.read(group)` returns per partition `{partition, committedOffset, endOffset, lag}`, `totalLag` 40 and `caughtUp: false`; after the consumer applies the rest, `totalLag` 0 and `caughtUp: true`; an unknown group raises `UnknownConsumerGroupError`.

---

### User Story 8 — "Do this once" travels as a single-consumer task (Priority: P2)

Fan-out events go to the log; commands that exactly one worker must run (send this mail, extract this document, judge this function version) go to a queue. Both must leave a transaction through the outbox, and the queue needs delay, FIFO grouping, dedupe, visibility timeouts and a dead-letter queue (P0601).

**Independent Test**: real queue stand-in from the test stack; fixture tasks and consumers.

**Acceptance Scenarios**:

1. **AS-90 (outbox to queue)** — **When** a transaction appends a task (`queue`, `body`, optional `groupId`, `delaySeconds`) and commits, **Then** one pending task row exists and the relay sends the body to the queue with the row ID as dedupe ID (FIFO); **When** the transaction rolls back, **Then** no row and no message exist.
2. **AS-91 (task rows are scrubbed)** — **When** the relay has sent a task, **Then** the row keeps its metadata (queue, aggregate ID, type, timestamps) but its body is cleared, so single-use secrets in a task body (a reset token) do not stay in the table; a failed send keeps the body until it succeeds or is parked.
3. **AS-92 (delay)** — **When** a task is enqueued with `delaySeconds: 2`, **Then** it is invisible for about 2 s and then delivered once; **When** `delaySeconds` is negative, fractional or above 900, or combined with a FIFO `groupId`, **Then** the call rejects with `InvalidEnqueueOptionsError` before any network call.
4. **AS-93 (FIFO group and dedupe)** — **Given** a FIFO queue, **When** two messages with the same `dedupeId` are enqueued within the dedupe window, **Then** one is delivered; messages of one `groupId` are delivered in order, one at a time, and a failing message blocks only its own group.
5. **AS-94 (concurrency and visibility)** — **Given** a consumer with concurrency 4 and visibility timeout 6 s, **When** 20 messages arrive and each handler takes 15 s, **Then** never more than 4 are in flight, each message is delivered once (the visibility timeout is extended while the handler runs), and the message is deleted only after the handler succeeds.
6. **AS-95 (redelivery and dead-letter)** — **Given** a handler that always throws and `maxReceiveCount` 3, **When** the message is delivered, **Then** it is redelivered with `receiveCount` 2 and 3 after the visibility timeout, and then moves to the queue's dead-letter queue.
7. **AS-96 (invalid body)** — **Given** a consumer with a body schema, **When** a message whose body fails it arrives, **Then** it is sent to the dead-letter queue at once with reason `SCHEMA_INVALID`, the handler is never called, and no effect happens.
8. **AS-97 (duplicate delivery)** — **When** the same message is delivered twice to a consumer using `recordOnce`, **Then** exactly one effect exists.
9. **AS-98 (graceful stop)** — **When** `stop()` is called with 2 messages in flight, **Then** it resolves after both finish and no further receive call is made.
10. **AS-99 (batch enqueue)** — **When** 25 tasks are enqueued as a batch, **Then** all 25 are delivered (sent in chunks of 10); **When** the queue rejects one entry, **Then** the result lists the failed entry's index and reason, the other 24 are delivered once, and re-enqueueing only the failed entry creates no duplicates.
11. **AS-100 (event to task bridge)** — **Given** a log consumer that forwards `fixtures.invite_requested` to a queue with `dedupeId = eventId:recipientId`, **When** the event is delivered twice, **Then** the queue holds one message per recipient.
12. **AS-101 (trace through the queue)** — **When** a task is enqueued inside an active span and consumed, **Then** the handler's span has the same trace ID.

---

### User Story 9 — Consume, transform, produce exactly once inside the log (Priority: P2)

An aggregator reads raw events, writes derived events, and must not double-count after a crash. Inside the log, output messages and input offsets can commit as one transaction (notes §2.2).

**Independent Test**: real log with transaction support; fixture pipeline; a `read_committed` reader.

**Acceptance Scenarios**:

1. **AS-102 (atomic commit)** — **When** the pipeline processes 10 input events and outputs 3 derived events, **Then** a `read_committed` reader sees the 3 outputs exactly once and the input group's committed offset advanced by 10, in the same transaction.
2. **AS-103 (abort)** — **Given** the pipeline crashes after sending outputs but before committing, **When** a `read_committed` reader reads, **Then** it sees none of them; **When** the pipeline restarts, **Then** the inputs are redelivered and the outputs appear exactly once.
3. **AS-104 (zombie fenced)** — **Given** two instances with the same transactional identity, **When** the older one tries to commit after the newer one started, **Then** the older commit is rejected (fenced), it stops processing, and the outputs are not duplicated.

---

### User Story 10 — An operator can see it and tell it is healthy (Priority: P2)

**Acceptance Scenarios**:

1. **AS-105 (metrics)** — **Given** a run that published, consumed, deduplicated, dead-lettered and parked messages, **When** metrics are scraped, **Then** these exist with these meanings and only low-cardinality labels (consumer, topic, outcome, reason; never an ID): `outbox_pending` (gauge), `outbox_oldest_pending_age_seconds` (gauge), `outbox_published_total`, `outbox_publish_failures_total`, `outbox_parked` (gauge), `consumer_events_total{consumer, outcome}` with outcomes `applied`, `duplicate`, `stale`, `ignored`, `coalesced`, `dlq`, `projection_lag_seconds{consumer}` (histogram of `now − occurredAt` for every applied event), `consumer_paused_total{consumer, reason}`, `dlq_total{consumer, reason}`, `dlq_write_failures_total`, `read_your_writes_total{outcome, reason}`, `task_queue_depth` and `task_queue_oldest_message_age_seconds`.
2. **AS-106 (logs)** — **When** every code path of this capability logs (publish failure, park, DLQ, pause), **Then** no line contains a payload value, token, e-mail address or the whole message; lines carry `eventId`, `consumer`, `topic`, `reasonCode`, `traceId`.

---

### User Story 11 — Event contracts evolve without breaking readers (Priority: P2)

**Acceptance Scenarios**:

1. **AS-107 (tolerant reader)** — **Given** a consumer for `fixtures.item_changed` v1, **When** the producer adds an optional field in the same version, **Then** the consumer applies the event and ignores the field; **When** a required field is missing, **Then** it is dead-lettered with `SCHEMA_INVALID` (AS-51). Producers may not emit fields outside the schema (AS-04 strictness on the producing side).
2. **AS-108 (contract package)** — **When** an envelope produced by an event definition is parsed with the envelope schema from `packages/contracts`, **Then** it parses; **When** a fixture event's payload is parsed with the contract schema the fixture domain exports, **Then** it parses; a drift between definition and contract fails this test (VII.6).

---

### Edge Cases

- **Duplicates enter at two points** (producer retries and consumer redelivery): the idempotent producer removes the first (AS-26); the inbox, version guard or natural idempotency removes the second (AS-28 to AS-30). A second producer sending the same business event twice is not de-duplicated by the log; consumers still are.
- **Relay ordering versus commit order**: rows are claimed in creation order, but a long transaction can commit after a later one. Per-aggregate correctness therefore rests on the aggregate's own conditional update (AS-06) plus the consumer's version guard (AS-33), not on the relay alone.
- **Event for a rolled-back change**: impossible by construction (AS-02). **Event lost after commit**: impossible while the row exists (AS-14, AS-18 make a lost row visible through `outbox_parked`).
- **A topic's partition count changes**: keys move to other partitions and per-key order breaks during the transition; partition counts are chosen up front and changes need an operator-run procedure with consumers' version guards as the safety net (assumption).
- **A poison event of an aggregate is dead-lettered**: later events of that aggregate continue; the version guard tolerates the gap, the dead letter is redriven after the fix (AS-63).
- **Replay of side-effecting consumers**: refused by default (AS-87). **Replay of a topic whose old events were deleted**: refused (AS-88).
- **Clock skew**: `occurredAt` comes from the producer's clock; the lag metric can read negative on skew and is clamped at 0.
- **Large fan-out topics**: no consumer group can slow another (AS-39).
- **Cross-tenant access**: the framework carries no tenant-scoped data; the only user-reachable surface is the read-your-writes helper behind a tenant-scoped read, tested in AS-78. DLQ, redrive, rebuild and lag are operator commands and services, not HTTP endpoints.

## Requirements *(mandatory)*

### Functional Requirements

**Event contract and topics**

- **FR-001**: Every event MUST carry `eventId` (UUIDv7), `type`, `version` (the payload contract version, a positive integer), `aggregateType`, `aggregateId`, `aggregateVersion` (non-negative integer, the aggregate's version after the change), `occurredAt` (ISO 8601 UTC from the injected clock), optional `traceparent`, and `payload` (AS-01, AS-10, AS-108).
- **FR-002**: Events MUST be created only from typed definitions that validate the payload strictly on the producing side and return a typed value; a definition's `type` is lowercase dotted and `(type, version)` is unique (AS-04, AS-10).
- **FR-003**: A serialized envelope above 256 KiB MUST be rejected at creation (AS-07). Event design prefers state-carrying events for read-model sources and says so with a `carries: state` marker on the definition (AS-12, AS-41).
- **FR-004**: The topic of an event MUST be `<aggregateType>.events`, keyed by `aggregateId`, and the aggregate type MUST be registered by its owning domain at module start with partition count and retention policy (`full-history` or `latest-per-key`); this capability MUST hold no list of domain topics (AS-11).
- **FR-005**: A `latest-per-key` topic MUST be accepted only if every event definition on it carries state; `aggregateVersion` MUST increase strictly per aggregate including on delete (AS-12, AS-42).
- **FR-006**: Consumers MUST tolerate additional payload fields within a contract version and MUST reject missing or mistyped required fields; a breaking change MUST use a new contract `version`, with both versions coexisting on the topic and consumers upgrading old versions (AS-53, AS-54, AS-107).
- **FR-007**: The envelope schema and each domain's event payload schemas MUST live in `packages/contracts`, and tests MUST parse produced envelopes with them (AS-108).

**Outbox append**

- **FR-008**: `append` MUST write outbox rows in the caller's active transaction and MUST reject with `NoActiveTransactionError` when none exists; `appendStandalone` MUST be the only way to append without a surrounding transaction (AS-01, AS-02, AS-03).
- **FR-009**: Several events in one call MUST be written in one statement and keep their order (AS-05).
- **FR-010**: `appendTask` MUST write a single-consumer task row (queue, body, optional group, delay, aggregate ID, type) in the caller's transaction, with the same transaction rules as `append` (AS-90).
- **FR-011**: A framework-free append over a plain database connection and a documented row contract MUST exist for non-Nest writers, and the database MUST reject rows that break the contract (AS-08).
- **FR-012**: No domain MAY access the outbox or inbox tables except through this capability's exported services (IX.6), and the check MUST run in CI (AS-09).

**Relay**

- **FR-013**: The relay MUST publish each row's envelope unwrapped as the message value, keyed by `aggregateId`, with headers `eventId`, `type`, `version`, `traceparent`, and the poller and the CDC connector MUST produce identical topic, key, value and headers (AS-13, AS-21).
- **FR-014**: The poller MUST claim rows with a lease (default 30 s) so that no two relays publish the same row while the lease holds, and a crashed relay's rows MUST become claimable after the lease (AS-16, AS-20).
- **FR-015**: Publication MUST be at least once: a crash between send and mark yields a duplicate with the same `eventId`, never a loss (AS-15).
- **FR-016**: A row that fails to publish MUST be retried with exponential backoff and full jitter (base 1 s, cap 60 s) and MUST hold back later rows of the same aggregate while it is pending (AS-14, AS-17).
- **FR-017**: After 10 failed attempts, or at once for a non-retryable broker error, a row MUST be parked, counted, logged without payload, and no longer block later rows; an operator operation MUST requeue it (AS-18, AS-19).
- **FR-018**: The relay mode MUST be validated at startup (`poller` or `cdc`); in `cdc` mode no poller runs; the shipped connector configuration MUST include only the outbox table (AS-22, AS-23).
- **FR-019**: Published rows MUST be purged after a retention period (default 7 days) by a single-run job in bounded batches; unpublished and parked rows MUST never be purged (AS-24).
- **FR-020**: Task rows MUST be relayed to their queue with the row ID as dedupe ID, and their body MUST be cleared after a successful send (AS-90, AS-91).
- **FR-021**: The poller MUST run on every replica on a local ticker and MUST NOT be a scheduled job (S49 FR-060).

**Plain producer**

- **FR-022**: A plain producer MUST validate the envelope, send keyed by `aggregateId` with acknowledgement from all in-sync replicas and the idempotent-producer setting, apply a 10 s timeout, and use no database (AS-25, AS-26).
- **FR-023**: Trace context MUST travel in `traceparent` from `append` or `publish` to the consumer's span (AS-27).

**Consumer framework**

- **FR-024**: Each consumer MUST run in its own consumer group named by the consumer, so that offsets, lag, dead letters and rebuilds are independent (AS-39).
- **FR-025**: A consumer MUST declare its idempotency mechanism (`inbox`, `versionGuard` or `natural`); registration without one, or with a duplicate group name, MUST fail at startup (AS-43).
- **FR-026**: The framework MUST validate every message as an envelope and every payload against the consumer's schema for that `(type, version)` before any effect; unknown types are skipped, newer versions dead-lettered, older versions upgraded (AS-50 to AS-55).
- **FR-027**: A consumer MAY declare an aggregate-ID schema; violations MUST be dead-lettered (AS-55).
- **FR-028**: Within a partition, events of one aggregate MUST be handled one at a time in log order, and no more than 500 events (configurable) MAY be inside handlers at once (AS-35, AS-61).
- **FR-029**: Offsets MUST be committed only after the effects of everything up to them, and a forced disconnect MUST lead to redelivery rather than loss (AS-36, AS-37).
- **FR-030**: Group rebalances MUST NOT cause one partition to be handled by two members at once nor an event to be applied twice in effect; the assignment strategy minimises movement (sticky, cooperative where the client supports it) (AS-38).
- **FR-031**: The `inbox` mechanism MUST record `(consumer, eventId)` in the same transaction as the effect, and concurrent duplicates MUST yield one effect (AS-28, AS-31, AS-32, AS-49).
- **FR-032**: The `versionGuard` mechanism MUST apply an event only when its `aggregateVersion` is strictly greater than the stored one, count equal as `duplicate` and lower as `stale`, and keep a versioned tombstone on delete (AS-29, AS-33, AS-34, AS-42, AS-71).
- **FR-033**: A consumer declared `coalesce` MUST receive only the highest `aggregateVersion` per aggregate of a batch, while metrics still count every event; coalescing MUST be allowed only for state-carrying events (AS-40, AS-41).
- **FR-034**: A failing handler MUST be retried up to the consumer's attempt budget (default 3, configurable) with full-jitter backoff (200 ms base, 5 s cap), then dead-lettered with `HANDLER_FAILED` (AS-57, AS-58).
- **FR-035**: Failures classified transient (timeouts, connection loss, throttling, saturated store) MUST pause the partition and retry with backoff and MUST NOT dead-letter; unclassified and permanent failures follow FR-034 (AS-59, AS-60).
- **FR-036**: A handler MUST have a timeout (default 30 s) that counts as a transient failure and MUST NOT let the group session expire (AS-65).
- **FR-037**: The dead-letter topic `<consumer>.dlq` MUST receive original bytes and the headers of AS-56; if it cannot be written, the offset MUST NOT be committed and no message dropped (AS-56, AS-62).
- **FR-038**: An operator redrive MUST republish dead letters to their source topic with the original key, at most 3 times per message (AS-63).
- **FR-039**: Consumers MUST stop gracefully: finish the in-flight batch, commit, disconnect within 20 s (AS-64).
- **FR-040**: A consumer MAY be started alone in `apps/projector` or `apps/worker` through its domain's module; apps wire modules, not consumers (constitution I.5, X.1).

**Inbox service**

- **FR-041**: `claim(source, eventId)` MUST record a handling attempt atomically and return `CLAIMED`, `DUPLICATE_IN_PROGRESS` or `DUPLICATE_DONE` with the status; statuses are `RECEIVED`, `PROCESSED`, `IGNORED`, `UNMATCHED`, `REJECTED`, `FAILED`; `FAILED` and `RECEIVED` older than 5 minutes MUST be claimable again with attempts incremented (AS-44 to AS-47).
- **FR-042**: `recordOnce(consumer, eventId)` MUST join the caller's transaction (AS-49). Terminal rows older than 30 days MUST be purged in bounded batches by a single-run job (AS-48).

**Versioned sinks**

- **FR-043**: Redis, Elasticsearch, DynamoDB, Cassandra/Scylla and ClickHouse sinks MUST each apply only newer versions, treat stale and equal as skipped outcomes (not errors), and be safe under two racing writers (AS-66 to AS-70).
- **FR-044**: A pure `applyIfNewer` decision (`apply | duplicate | stale`) MUST be exported for domain-owned tables, so domains write their own conditional update without this capability naming their tables (AS-71).
- **FR-045**: A batch that fails partway MUST be retried as a whole and converge to the same state (AS-72).

**Read-your-writes**

- **FR-046**: Checkpoints MUST be recorded after the sink write for every outcome, only ever increase, and expire (default 24 h) so that memory is bounded (AS-80).
- **FR-047**: The read helper MUST serve from the read model when its checkpoint ≥ `minVersion`, otherwise wait within a budget (default 500 ms, max 2,000 ms, jittered 10 to 100 ms polls), then fall back to the caller-supplied write-model read (R1, principal-scoped) or answer `202` with `Retry-After` and `requiredVersion` (AS-73 to AS-76, AS-81).
- **FR-048**: `minVersion` MUST be an integer in `[0, 2^53−1]`; anything else MUST be a `400` problem+json that does not wait (AS-77).
- **FR-049**: The helper MUST NOT consult checkpoints, wait, or reveal a version before the caller's tenant-scoped check passes; a non-owner gets the same `404` as a missing ID (AS-78).
- **FR-050**: If the checkpoint store is unavailable the helper MUST fall back at once without error (AS-79). A replica's version MAY serve as the probe (AS-81).

**Replay and rebuild**

- **FR-051**: In-place replay MUST reset a stopped group to the earliest offset and be idempotent; it MUST refuse while the group has live members (AS-82, AS-83).
- **FR-052**: A shadow rebuild MUST run a new consumer version in its own group into a new target; promotion MUST be refused while lag exceeds the gate (default 1,000 events) or verification fails, MUST switch atomically, MUST keep the old version, and rollback MUST be possible (AS-84, AS-85).
- **FR-053**: An interrupted replay MUST resume from committed offsets (AS-86).
- **FR-054**: A consumer declared `replayable: false` MUST NOT be rewound without an explicit flag and reason, and the override MUST be audited (AS-87).
- **FR-055**: A rebuild from scratch MUST be refused when history is truncated on a non-compacted topic unless explicitly allowed (AS-88).
- **FR-056**: `ConsumerLag.read(group)` MUST return per-partition committed offset, end offset and lag, a total and `caughtUp` (AS-89).

**Single-consumer tasks (queue port)**

- **FR-057**: `enqueue` and `enqueueBatch` MUST validate options (`delaySeconds` an integer in `[0, 900]`, not with a FIFO group; `dedupeId` and `groupId` only for FIFO) before any call, send trace context as message attributes, and report per-entry failures of a batch (AS-92, AS-99, AS-101).
- **FR-058**: `consume` MUST bound concurrency, extend visibility while a handler runs, delete only after success, expose `receiveCount`, validate bodies with the consumer's schema and send invalid bodies to the dead-letter queue at once, and stop gracefully (AS-94 to AS-98).
- **FR-059**: FIFO messages of one group MUST be delivered in order one at a time, and a failing message MUST block only its group (AS-93).
- **FR-060**: A log consumer MAY forward an event as a task; the bridge MUST make the queue message identity derive from the event (`eventId` plus recipient) (AS-100).

**Kafka transactions**

- **FR-061**: A transactional consume-transform-produce pipeline MUST commit output messages and input offsets in one transaction under a stable identity, MUST show nothing to `read_committed` readers on abort, and MUST fence an older instance (AS-102 to AS-104). Effects outside the log are not covered; they use an inbox.

**Observability and safety**

- **FR-062**: The metrics of AS-105 MUST exist with low-cardinality labels; spans MUST be created per batch and per task; logs MUST follow AS-106.
- **FR-063**: Every outbound call (log, queue, stores) MUST have an explicit timeout; retries happen at exactly one layer (constitution IV.6).
- **FR-064**: All configuration (intervals, limits, retention, relay mode) MUST be validated at startup and startup MUST fail on invalid values.

### Pattern coverage

| Pattern | Requirements and scenarios |
|---|---|
| P0111 Typed event map, template-literal topics | FR-002, FR-004; AS-10, AS-11 |
| P0112 Runtime validation at boundaries | FR-026, FR-006; AS-50 to AS-55, AS-107 |
| P0317 Read-your-writes, replica lag | FR-046 to FR-050; AS-73 to AS-81 |
| P0322 CDC (Debezium) | FR-013, FR-018, FR-021; AS-21, AS-22, AS-23 |
| P0408 CQRS read models | FR-043 to FR-045; AS-66 to AS-72 |
| P0413 Event versioning | FR-001, FR-006; AS-53, AS-54, AS-107 |
| P0601 Queue vs log, bridge to the queue | FR-010, FR-057 to FR-060; AS-39, AS-90 to AS-101 |
| P0603 Idempotent producer, Kafka transactions | FR-022, FR-061; AS-25, AS-26, AS-102 to AS-104 |
| P0605 Consumer groups, rebalancing | FR-024, FR-030; AS-38, AS-39 |
| P0606 Outbox, inbox, idempotent consumers | FR-008 to FR-021, FR-025, FR-031, FR-041, FR-042; AS-01 to AS-24, AS-28 to AS-32, AS-44 to AS-49 |
| P0607 Per-key ordering | FR-004, FR-016, FR-028, FR-032; AS-17, AS-33, AS-35 |
| P0608 Event design: envelope, versioning, thin vs fat | FR-001, FR-003; AS-01, AS-07 |
| P0609 Consumer backpressure | FR-028, FR-035; AS-59 to AS-61 |
| P0706 Trace propagation across Kafka/SQS | FR-023, FR-057; AS-27, AS-101 |

### Key Entities *(include if feature involves data)*

- **Event envelope**: the message every event travels in (fields in FR-001). Immutable once created.
- **Outbox row** (table owned by this capability): kind (`event` or `task`), topic or queue, aggregate ID, type, envelope or task body, status (`pending`, `published`, `parked`), attempts, next attempt time, parked reason, created and published times.
- **Inbox record** (table owned by this capability): source (a provider or a consumer name), `eventId`, status, attempts, claim time, handled time.
- **Topic registration**: aggregate type, partitions, retention policy, registered by the owning domain.
- **Consumer declaration**: group name, topics, idempotency mechanism, coalescing, attempt budget, replayable flag, supported contract versions with upgrades, aggregate-ID rule.
- **Checkpoint**: highest applied `aggregateVersion` per (consumer, aggregate), expiring.
- **Dead letter**: original message plus the header set of AS-56.
- **Task**: queue, body, optional group, delay, dedupe ID.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Across 10,000 randomized commit/rollback transactions with injected relay crashes and broker outages, committed events missing from the log: 0; events present for rolled-back changes: 0 (AS-01, AS-02, AS-14, AS-15).
- **SC-002**: With every delivery duplicated and shuffled within each aggregate, every read model equals the result of applying each aggregate's newest version once (AS-28 to AS-34, AS-66 to AS-70).
- **SC-003**: A malformed or schema-invalid message delays the other messages of its partition by less than 2 s and leaves no effect; a 30-second store outage dead-letters 0 messages (AS-50, AS-51, AS-59).
- **SC-004**: A writer who sends `minVersion` sees their own write in 99% of reads within 500 ms and in 100% within 2.5 s (fallback or `202`), never an older version (AS-73 to AS-76).
- **SC-005**: Projection lag p99 stays under 2 s at 1, 2 and 4 consumer instances on a flood of 100,000 events, scaling roughly linearly (load script from F-05; reported, not a CI gate).
- **SC-006**: A shadow rebuild of a 100,000-event read model completes with zero failed reads on the live target and promotion refused until caught up (AS-84).
- **SC-007**: An operator can answer "how far behind is consumer X, how many rows are parked, how many dead letters in the last hour" from metrics and the lag read alone, without querying a table (AS-89, AS-105).
- **SC-008**: Zero domain code references the outbox or inbox tables directly (AS-09).

## Assumptions

- Defaults of this spec (configurable, validated at startup): payload limit 256 KiB; relay poll every 2 s, batch 100, lease 30 s, backoff base 1 s and cap 60 s with full jitter, park after 10 attempts, publish timeout 10 s; published-row retention 7 days; inbox terminal retention 30 days, claim lease 5 minutes; consumer batch up to 500 events or 50 ms, attempt budget 3, backoff base 200 ms and cap 5 s, handler timeout 30 s, in-flight limit 500, redrive limit 3, graceful stop 20 s; read-your-writes wait 500 ms (max 2,000 ms), checkpoint expiry 24 h; replay promotion gate 1,000 events; queue delay at most 900 s, batch chunk 10; default 12 partitions per topic and 64 for topics declared hot; replication factor 3 and minimum in-sync replicas 2 in production.
- A **version guard compares strictly**: equal versions are duplicates. This changes today's "equal is applied" behaviour on purpose (`questions.md`).
- The envelope uses `type`, `version` and `aggregateVersion`, as constitution IV.4 and the other written capabilities (S01, S10, S13, S14, S39) assume. Each domain also keeps its own named version in the payload (`orderVersion`, `productVersion`) as those specs require; the framework uses `aggregateVersion`.
- Postgres, the log (Redpanda in tests), the queue stand-in, Redis, Elasticsearch, DynamoDB, Scylla and ClickHouse come from the test stack. The CDC connector is added to the test stack as an opt-in profile, and its e2e spec runs when that profile is up (gap in `gaps.md`).
- The log client in use may not support cooperative rebalancing; the requirement is "sticky with minimal movement", and AS-38 proves the behaviour, not the algorithm.
- Admin operations (rebuild, promote, rollback, redrive, requeue parked rows, lag read) are commands and exported services, not HTTP endpoints. The admin page of F-05 ("projection lag, rebuild button") is a later web capability; no UI journey belongs to this one.
- The idempotency-key HTTP facility (S10/S54) and the Lambda event-source adapter (S55) are separate; the contracts toward them are in `questions.md`.
- The ownership registry changes the inbox table's owner from `infrastructure:idempotency` to `infrastructure:inbox`; the table keeps its name (IX.2).
- Tests freeze time with the shared fake clock and assert persisted state (outbox and inbox rows, log contents, read-model contents, checkpoints, metrics) in every case.

## Cross-capability contracts

### Provides

All exports come from `@app/infrastructure/events`, `@app/infrastructure/outbox`, `@app/infrastructure/inbox`, `@app/infrastructure/projections`, `@app/infrastructure/sqs`; contract schemas from `packages/contracts`. Domains import infrastructure directly (X.5) and never the reverse.

- **`defineEvent(type, aggregateType, version, schema, options?: { carries?: 'state' | 'delta' })`** → `{ type, version, aggregateType, topic, schema, create(aggregateId, aggregateVersion, payload, occurredAt?), match(envelope) }`. `create` throws `InvalidEventPayloadError`, `EventTooLargeError`; registration throws on a bad type or duplicate `(type, version)`. Envelope: `{ eventId, type, version, aggregateType, aggregateId, aggregateVersion, occurredAt, traceparent?, payload }` (**exact names**; replaces today's `eventName`, `version`, `schemaVersion`).
- **`TopicRegistry.register({ aggregateType, partitions?, hot?: boolean, retention: 'full-history' | 'latest-per-key' })`**, called by each domain module at init; topic name `<aggregateType>.events`.
- **`OutboxService`**:
  - `append(events: EventEnvelope | EventEnvelope[]): Promise<void>` joins the active (CLS) transaction; throws `NoActiveTransactionError` otherwise.
  - `appendStandalone(events): Promise<void>` own short transaction.
  - `appendTask({ queue: string, type: string, aggregateId: string, body: unknown, groupId?: string, delaySeconds?: number }): Promise<void>` joins the active transaction; relayed to the queue; body cleared after send.
  - `appendWithExecutor(executor: { query(sql, params): Promise<unknown> }, events | task): Promise<void>` framework-free, for Lambda and other non-Nest code; the documented row contract is the same table.
  - `requeueParked(rowId | { type?, olderThan? }): Promise<number>` (operator).
- **`EventPublisher.publish(envelope): Promise<void>` and `publishMany(envelopes)`**: plain producer, idempotent, keyed, 10 s timeout, no database. Errors `InvalidEnvelopeError`, `PublishTimeoutError`. For events with no SQL transaction to be atomic with (S25, S26, S23 high-volume `live.*`). The caller supplies a stable `eventId` so its own relay can retry safely.
- **`InboxService`**: `claim(source: string, eventId: string): Promise<{ outcome: 'CLAIMED' | 'DUPLICATE_IN_PROGRESS' | 'DUPLICATE_DONE'; status: 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'UNMATCHED' | 'REJECTED' | 'FAILED'; attempts: number }>`, `markStatus(source, eventId, status, detail?)`, `recordOnce(consumer: string, eventId: string): Promise<boolean>` (joins the active transaction), `purge(olderThan: Date): Promise<number>`. For S10's webhook inbox (replaces its raw SQL) and every `inbox` consumer.
- **`Projector` (consumer contract) and `ProjectionsModule.forProjectors(types, imports?)`**: `{ name; topics; idempotency: 'inbox' | 'versionGuard' | 'natural'; coalesce?: boolean; attempts?: number (default 3); replayable?: boolean (default true); aggregateIdSchema?: ZodType; handles: [{ event: EventDefinition, upgradeFrom?: {version, upcast}[] }]; project(events): Promise<void> }`. Errors to throw from sinks and handlers: `SinkBackpressureError(message, retryAfterMs)`, `TransientError`, `PermanentError`. Hosted by `apps/projector` or `apps/worker` through the owning domain's module.
- **Sinks**: `RedisDocSink.upsertMany`, `EsVersionedSink.bulkIfNewer`, `DynamoVersionedSink.putManyIfNewer`, `CassandraVersionedSink.writeAll`, `ClickHouseSink.insert(table, rows, { dedupeToken })`; each returns counts `{applied, duplicate, stale}`. **`applyIfNewer(stored: number | null, incoming: number): 'apply' | 'duplicate' | 'stale'`** for domain-owned tables.
- **`ProjectionCheckpoints.record(consumer, events)`** (called by the framework after the sink write) and **`ReadYourWrites.resolve({ consumer, aggregateType, aggregateId, minVersion, waitMs?, onBehind: 'fallback' | 'pending', readWriteModel: () => Promise<T> })`** → `{ source: 'read-model' | 'write-model'; value?: T } | { source: 'pending'; requiredVersion }`. `readWriteModel` is the caller's R1 exported-service read, already scoped to the principal.
- **`ConsumerLag.read(group): Promise<{ partitions: { partition, committedOffset, endOffset, lag }[]; totalLag: number; caughtUp: boolean }>`**; CLI commands `projections:rebuild`, `projections:promote`, `projections:rollback`, `projections:redrive`, `outbox:requeue`.
- **`TransactionalPipeline`** (S36): `run({ id, inputTopic, group, outputTopic, transform(batch): Promise<EventEnvelope[]> })` with stable transactional identity, offsets in the transaction, fencing.
- **`TaskQueue` port**: `enqueue(queue, body, { delaySeconds?, groupId?, dedupeId?, attributes? })` (**`dedupeId`** replaces `deduplicationId`), `enqueueBatch(queue, [{ body, options? }]) → { sent, failed: { index, reason }[] }`, `consume(queue, handler, { concurrency?, visibilityTimeoutSec?, bodySchema? }) → stop()`, `TaskMessage { id, body, receiveCount, attributes }`; errors `InvalidEnqueueOptionsError`.
- **Single-run jobs registered with S49**: `outbox.purge-published`, `inbox.purge`.
- **Event guarantees**: at-least-once delivery, per-aggregate order on the log for rows that are pending in order, stable `eventId` across duplicates, `aggregateVersion` strictly increasing per aggregate.

### Requires

- **S49** (`infrastructure/jobs`): `JobsService.upsertSchedule({ name, cron, jobType, payload, overlap: 'skip' })` and `@JobHandler(type)` for the two purge jobs; **not** for the poller (local ticker, S49 FR-060).
- **S54** (`infrastructure/platform`, `common`): the clock (`now()` injectable), config validation at startup, metrics registry, `ShutdownRegistry` with ordered hooks, the CLS transaction runner (`@Transactional`, active-transaction lookup), the problem+json filter and validation pipe for the fixture routes' `400`.
- **S32** (`infrastructure/elasticsearch`, debt D-16): a generic client with bulk writes using external versioning; `EsVersionedSink` is built on it.
- **Every producing domain** (S01–S47): registers its aggregate types, exports its event definitions and contract schemas, and appends in its own transaction; passes the same number as `aggregateVersion` and as its named payload version.
- **Every consuming domain**: declares one idempotency mechanism per consumer and exports its consumer module (not the consumer class) for `apps/projector` (debt D-8).
- **S05**: `catalog.product_*` events on `products.events` carry the full product state, `aggregateVersion` strictly increases including on delete, registered `latest-per-key` (S32 replay relies on it).
- **S10**: the webhook controller uses `InboxService.claim('stripe', eventId)` and `markStatus` instead of raw SQL.
- **S24**: the Rust gateway writes outbox rows in its own transaction following the row contract (no CDC on chat tables, IX.6).
- **S55**: its Lambda adapter maps `TaskQueue` per-message outcomes to the event-source partial-batch response.
- Infrastructure test stack (docker-compose.test.yaml): Postgres 18, Redpanda with transactions, ElasticMQ (FIFO and dead-letter), Redis, Elasticsearch, DynamoDB local, Scylla, ClickHouse; plus an opt-in CDC profile.
