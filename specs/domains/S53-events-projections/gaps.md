# Gaps: S53 — current `infrastructure` events/outbox/projections code versus the spec

The implementation agent's to-do list. Paths are under `packages/backend/libs/infrastructure/` unless stated; line numbers are those read on 2026-10-06. The lib is `events` (3 files), `outbox` (9 files), `projections` (9 files plus 4 sinks), `kafka` (5), `sqs` (5), `idempotency` (1). Rows marked **[BREAKING]** are tagged in `questions.md`; update the existing tests and callers listed in section N.

## A. Event contract, append, topics

| # | Gap | Where | Spec |
|---|---|---|---|
| G-01 | Envelope uses `eventName`, `version` (aggregate version) and `schemaVersion`; the constitution and ten sibling specs use `type`, `version` (contract), plus a separate aggregate version. No `aggregateVersion` field name. **[BREAKING]** | `events/event-envelope.ts:12-22,28-36`, `events/define-event.ts:12-27,45-55` | FR-001, AS-01, AS-108 |
| G-02 | `eventEnvelopeSchema` lives in infrastructure; no event or envelope schema exists in `packages/contracts` (no file matches `*event*`), so VII.6 cannot be met | `events/event-envelope.ts:10` | FR-007, AS-108 |
| G-03 | `defineEvent` accepts any name (no `a.b_c` rule), allows duplicate `(type, version)` (no registry), has no `carries` marker, no size cap, throws a raw `ZodError`, and reads the clock with `new Date()` as a default argument | `events/define-event.ts:24-26,45-55` | FR-002, FR-003, AS-04, AS-07, AS-10 |
| G-04 | `DomainEventsService.record` writes with no transaction check (a call outside a transaction is a silent dual write), derives the topic as a string without a registry, and sets `nextAttemptAt: new Date()` (clock not injected). **[BREAKING]** | `events/domain-events.service.ts:18-32` | FR-004, FR-008, AS-03, AS-11 |
| G-05 | `OutboxService.notify` opens its own transaction when none is active; `wrapInOutbox` retries in-process and writes a DLQ row to the outbox on failure. Both are replaced by `append*` and the consumer framework's dead-letter topic. **[BREAKING]** | `outbox/outbox.service.ts:20-106,108-124` | FR-008, FR-037 |
| G-06 | No `appendStandalone`, `appendTask`, `appendWithExecutor`, `requeueParked`; no documented row contract; no database constraints on the row (aggregate ID may be null; `payload` any) | `outbox/outbox.model.ts:70-100`, `outbox/types.ts` | FR-010, FR-011, AS-08, AS-90 |
| G-07 | `KafkaTopicGroup` enum hard-codes `payments.requests`, `payments.responses`, `payments.dlq`, `products.events`; no `TopicRegistry`, no partition or retention policy, no compaction rule. **[BREAKING]** | `outbox/outbox.model.ts:14-19`, used by `payments` and `catalog` (`catalog/infra/product-search.projector.ts:8,24`) | FR-004, FR-005, AS-11, AS-12 |

## B. Relay

| # | Gap | Where | Spec |
|---|---|---|---|
| G-08 | The poller sends `{ payload: envelope, extra, error }` as the message value, with no headers; Debezium (`table.expand.json.payload: true`) sends the envelope itself. The two relays disagree and the README claim "same shape" is false. **[BREAKING]** | `outbox/outbox-publisher.service.ts:90-94`, `infra/debezium/outbox-connector.json`, `infra/debezium/README.md:14-16` | FR-013, AS-13, AS-21 |
| G-09 | A row that fails is retried forever (no attempt cap, no parking); `Math.random` is used directly for jitter; backoff is not full jitter | `outbox/outbox-publisher.service.ts:100-116` (`:107`) | FR-016, FR-017, AS-14, AS-18 |
| G-10 | A later row of the same aggregate can be published before an earlier failed one in the same drain (rows are published one by one and failures do not hold their aggregate) | `outbox/outbox-publisher.service.ts:75-82` | FR-016, AS-17 |
| G-11 | No purge of published rows (table grows without bound), no purge job; README says "add a cleanup job" but none exists | `outbox/` (missing), `infra/debezium/README.md:35` | FR-019, AS-24 |
| G-12 | Key falls back to `payload.idempotency_key` (legacy payment rows) or the row ID; with the new contract the key is always `aggregateId` and a row without one is invalid. **[BREAKING]** | `outbox/outbox-publisher.service.ts:86-87` | FR-013, AS-08 |
| G-13 | No non-retryable classification (an oversized or invalid message retries until the end of time); no metrics (`outbox_pending`, oldest age, parked, published, failures); no startup validation of the relay mode beyond a string compare | `outbox/outbox-publisher.service.ts:38-50,100-116`, `common/config/api-config.service.ts:413` | FR-017, FR-018, FR-062, AS-19, AS-23, AS-105 |
| G-14 | CDC cannot be tested: `docker-compose.test.yaml` has no Debezium or Kafka Connect service; the connector sets only `eventName` as a header (no `eventId`, `type`, `version`, `traceparent`) and no purge exists for streamed rows | `docker-compose.test.yaml`, `infra/debezium/outbox-connector.json` | FR-013, FR-018, AS-21, AS-22 |
| G-15 | `KafkaProducerService` builds its own `Kafka` (duplicating `createKafka`), uses a bare `kafka.producer()` (not idempotent, no `acks`, no timeout), has no `publish(envelope)` that validates the envelope and no plain-producer API for domains without a transaction. **[BREAKING]** | `kafka/kafka-producer.service.ts:16-31,44-57` vs `kafka/kafka-client.factory.ts:9-22` | FR-022, AS-25, AS-26 |

## C. Consumer framework (`projections/`)

| # | Gap | Where | Spec |
|---|---|---|---|
| G-16 | `parseEnvelope` lifts any `{ payload }` message into a fake envelope (`<aggregate>.legacy`, version 0, `occurredAt: now`); because of G-08 every real relayed event takes this path today. Remove it. **[BREAKING]** | `projections/envelope-parser.ts:27-49` | FR-026, AS-50 |
| G-17 | No per-event-type payload validation or `(type, version)` routing in the runner: `Projector.project(events)` gets raw envelopes and each projector calls `match` itself; no unknown-type skip, no newer-version dead letter, no upgrade chain | `projections/projector.ts:7-22`, `projections/projection-runner.service.ts:78-86` | FR-026, AS-52 to AS-54 |
| G-18 | Offsets: `autoCommit: true` with manual `resolveOffset`; the timer can commit offsets of work still in flight; no commit-after-effect guarantee test | `projections/projection-runner.service.ts:64-68,103-104` | FR-029, AS-36, AS-37 |
| G-19 | Transient and permanent failures are not distinguished: after 3 failed batch attempts every event is projected alone and any failure is dead-lettered, so a store outage empties the topic into `<group>.dlq`. **[BREAKING]** | `projections/projection-runner.service.ts:117-142` | FR-035, AS-59 |
| G-20 | Attempt budget is a constant (`MAX_BATCH_ATTEMPTS = 3`), not per consumer; no handler timeout; no in-flight bound (only `maxBytesPerPartition`) | `projections/projection-runner.service.ts:12,52-58` | FR-034, FR-036, FR-028, AS-58, AS-61, AS-65 |
| G-21 | Dead letters carry only `x-source-topic` and `x-dlq-reason` (the raw error message, up to 500 characters, which can contain payload values); no reason code, partition, offset, consumer, attempts, time; the DLQ write is not guarded (a failing `send` throws out of the batch handler but nothing counts it); `<group>.dlq` topic is not created by the framework | `projections/projection-runner.service.ts:145-151` | FR-037, AS-56, AS-62, AS-106 |
| G-22 | No dead-letter redrive tool | `scripts/projections/` (missing) | FR-038, AS-63 |
| G-23 | No idempotency declaration, no duplicate-group check, no `replayable`, no `aggregateIdSchema`, no coalescing safety (any projector may set `coalesce`, even on delta events) | `projections/projector.ts:7-22`, `projections/projections.module.ts:27-35` | FR-025, FR-027, FR-033, AS-41, AS-43 |
| G-24 | Per-aggregate sequential handling and rebalance behaviour are not specified or tested; the consumer is created with kafkajs defaults (no assignor choice) | `projections/projection-runner.service.ts:52-58` | FR-028, FR-030, AS-35, AS-38 |
| G-25 | Lag is recorded for events that were dead-lettered (the loop uses all `valid` events, before projection success is known) and for coalesced-away events as applied; clock via `Date.now()`; no `outcome` counter | `projections/projection-runner.service.ts:100-101` | FR-062, AS-40, AS-105 |
| G-26 | `consumer.subscribe(fromBeginning: true)` makes a brand-new group read the whole topic; fine for read models, wrong for side-effect consumers (notifications) unless declared; no `replayable` guard | `projections/projection-runner.service.ts:60-62` | FR-054, AS-87 |
| G-27 | `KafkaConsumerService.consume` (legacy request/response path with `wrapInOutbox`) has no framework replacement and is used only by the payments flows; remove after S13 migrates | `kafka/kafka-consumer.service.ts:33-100` | FR-037 |

## D. Inbox

| # | Gap | Where | Spec |
|---|---|---|---|
| G-28 | No `InboxService`. The webhook controller runs raw SQL `INSERT INTO "ProcessedWebhookEvent" … ON CONFLICT DO NOTHING` (IX.6: only the owning lib's service may). The table has no status, attempts or claim time. **[BREAKING]** | `domains/orders/api/stripe-webhook.controller.ts:49`, `db/ownership.ts:170` | FR-041, AS-44 to AS-47 |
| G-29 | Ownership registry names the owner `infrastructure:idempotency`; the domain-map names `infrastructure:inbox`. No migration adds the columns, no purge job exists. | `db/ownership.ts:170`, `docs/architecture/domain-map.md:375` | FR-041, FR-042, AS-48 |
| G-30 | No consumer-side inbox (`recordOnce` in the caller's transaction), so every consumer that needs it hand-rolls or has none | (missing) | FR-031, FR-042, AS-28, AS-49 |

## E. Versioned sinks

| # | Gap | Where | Spec |
|---|---|---|---|
| G-31 | Redis Lua applies equal versions (`< current` returns 0 only for lower); no `{applied, duplicate, stale}` counts (returns only applied count); no tombstone for deletes. **[BREAKING]** | `projections/sinks/redis-doc.sink.ts:9-15,32-37` | FR-032, FR-043, AS-34, AS-42, AS-66 |
| G-32 | DynamoDB guard is `<=` (applies equal) | `projections/sinks/dynamo-versioned.sink.ts:21` | FR-043, AS-68 |
| G-33 | No Elasticsearch sink in `projections/sinks/`; external versioning lives in the product-index adapter (`bulkUpsertProducts`, `external_gte`) and depends on D-16 | `elasticsearch/` (product adapter), F-05 notes | FR-043, AS-67 |
| G-34 | Cassandra sink has no tie rule and no test; ClickHouse sink has no `dedupeToken` so a duplicate batch inserts duplicate rows until merge, and no error classification into transient | `projections/sinks/cassandra-versioned.sink.ts:20`, `projections/sinks/clickhouse.sink.ts:13-20` | FR-043, AS-69, AS-70 |
| G-35 | No exported pure `applyIfNewer` decision for domain-owned tables (domains reimplement it) | (missing) | FR-044, AS-71 |

## F. Read-your-writes, replay, lag

| # | Gap | Where | Spec |
|---|---|---|---|
| G-36 | Checkpoints are one Redis hash per `(projector, aggregateType)` with no expiry (unbounded); recorded only for events the projector passes in (coalesced-away and skipped events do not move it); `waitFor` returns a boolean, polls every fixed 25 ms with `Date.now()`, has no fallback or `202` path, no `minVersion` validation, no tenant rule, no store-down handling. **[BREAKING]** | `projections/read-your-writes.ts:8-46` | FR-046 to FR-050, AS-73 to AS-81 |
| G-37 | `rebuild.ts` resets offsets without checking for live members, replayability or truncated history; no `promote`, `rollback`, lag gate, verification, or audit line; the shadow-target path is documented in a comment only. **[BREAKING]** | `scripts/projections/rebuild.ts:36-70` | FR-051 to FR-055, AS-82 to AS-88 |
| G-38 | No `ConsumerLag.read` (committed vs end offsets, `caughtUp`); S16 and S32 need it | (missing) | FR-056, AS-89 |

## G. Task queue and transactions

| # | Gap | Where | Spec |
|---|---|---|---|
| G-39 | Option `deduplicationId` (spec: `dedupeId`); no validation of `delaySeconds` (comment says ≤ 900 but nothing checks); a delay combined with a FIFO group is silently dropped (`DelaySeconds: options.groupId ? undefined`). **[BREAKING]** | `sqs/task-queue.port.ts:2-9`, `sqs/sqs-task-queue.ts:32,47` | FR-057, AS-92 |
| G-40 | `enqueueBatch` throws on a partial failure after some entries were already sent (retrying the whole batch duplicates them); no `{sent, failed}` result. **[BREAKING]** | `sqs/sqs-task-queue.ts:55-58` | FR-057, AS-99 |
| G-41 | `consume` parses the body with `JSON.parse` and no schema; an invalid body is retried until `maxReceiveCount`; no `bodySchema`, no immediate dead-letter | `sqs/sqs-task-queue.ts:92-101` | FR-058, AS-96 |
| G-42 | No outbox-to-queue relay (`appendTask`) so S01, S04, S13, S45 cannot send a single-consumer command atomically with their state change; no scrubbing of task bodies | (missing) | FR-010, FR-020, AS-90, AS-91 |
| G-43 | No test at all for the queue port (in-memory fake and SQS adapter) | `sqs/` | AS-92 to AS-101 |
| G-44 | No generic transactional consume-transform-produce; the marketing click aggregator has its own copy (`domains/marketing/infra/click-aggregator.service.ts`) | (missing) | FR-061, AS-102 to AS-104 |

## H. Observability, tests, wiring

| # | Gap | Where | Spec |
|---|---|---|---|
| G-45 | Only `projection.lag` (histogram) and spans exist; no outbox metrics, no `consumer_events_total`, `dlq_total`, `consumer_paused_total`, `read_your_writes_total`, queue depth/age is in `queue-metrics.service.ts` but not under the names of AS-105 | `projections/projection-runner.service.ts:31-36`, `sqs/queue-metrics.service.ts` | FR-062, AS-105 |
| G-46 | Logs print the raw error message and the DLQ reason (may contain payload values) | `projections/projection-runner.service.ts:130,146`, `outbox/outbox-publisher.service.ts:101-103` | AS-106 |
| G-47 | Existing specs cover 6 of 108 scenarios, partly: `outbox-publisher.e2e-spec.ts` (broker down, recovery; **stubs the Kafka producer with `jest.spyOn`**, which VII.2 forbids, and seeds legacy idempotency-key rows through the shared seeds module) and `projection-runner.e2e-spec.ts` (out-of-order, checkpoint, poison; uses fixed `setTimeout(1_000)`, builds envelopes with the old field names) | `outbox/outbox-publisher.e2e-spec.ts:33,57-66`, `projections/projection-runner.e2e-spec.ts:95` | test-plan.md |
| G-48 | `events/`, `kafka/`, `sqs/`, `idempotency/` have no spec at all; no test of any sink other than Redis; no test of coalescing, backpressure, graceful stop, rebalance, DLQ unavailable, transactions | all | test-plan.md |
| G-49 | `config` has no validated settings for relay interval, lease, attempts, retention, consumer budgets, wait budget | `common/config/api-config.service.ts` (`outbox_relay` only) | FR-064 |
| G-50 | `ProjectionsModule.forProjectors` always provides `RedisDocSink` and `ProjectionCheckpoints`, no other sinks; the host app lists 25 projector classes imported from domain barrels (D-8) and imports `ShopMembershipModel` from tenancy to register a model in the projector app | `projections/projections.module.ts:31-37`, `apps/projector/src/projector.module.ts:1-20,53-60` | FR-040 |

## I. Debt register: open rows that name `infrastructure` or S53

| Row | State | What S53 does |
|---|---|---|
| **D-8** (barrels export infrastructure internals: projectors, consumers) | open | S53 provides the host contract (`Projector` plus `ProjectionsModule.forProjectors`) so that each consuming domain exports a consumer **module** and `apps/projector` imports modules, not classes (FR-040). Paid by each consuming capability; S53 supplies the declaration shape and fixture. |
| **D-16** (`libs/infrastructure/elasticsearch` is a product-index adapter) | open, resolved by S32 | `EsVersionedSink` (G-33) is built on the generic client that S32 delivers; order: S32 split first, or S53 ships the sink over the current client and moves with it. |
| **D-14** (LLM port in `assistant/infra/llm`, `llm-meter` calls billing) | open, resolved by S46 | S53 supplies the event path S46 uses (`llm.call_completed` through `append`); nothing else here. |
| **D-6** (layering inside domains: `api/`, `application/` import `infra/`) | open | `payments/api/payment.controller.ts:8,20` injects `OutboxService` in a controller (II.1); fixed by S13 through `append` in an application service. Not an S53 deliverable. |
| D-1, D-2, D-3, D-5, D-9 | resolved in Phase 3 | no action |
| D-7, D-12 | open | see section J |

## J. `pnpm --dir packages/backend check:table-ownership` for this domain

**Could not be run in this session** (the sandbox required approval for the command), so the result is derived from `scripts/check-table-ownership.ts`: it scans only `libs/domains/*`, so `infrastructure` has **zero lines** by construction, and it flags only tables whose owner starts with `domain:`. The outbox and inbox are owned by `infrastructure:*`, so accesses to them from domains are **invisible to the check**. IX.5 requires the check to fail on them, so the check itself is a gap: extend it to flag any reference to a technical table outside its owning infrastructure lib (G-51). Direct accesses found by reading the code:

| # | Finding | IX.7 / IX.6 mechanism that replaces it |
|---|---|---|
| G-51 | `domains/media/infra/media-processor.ts:70` raw `INSERT INTO "Outbox"` | IX.6 exported service: `OutboxService.append(event)` in the domain's transaction (S29/S30 own the change) |
| G-52 | `domains/catalog-sync/application/catalog-import.service.ts:217` raw `INSERT INTO "Outbox"` | IX.6: `OutboxService.append` (S07) |
| G-53 | `domains/orders/api/stripe-webhook.controller.ts:49` raw SQL on `"ProcessedWebhookEvent"` inside a controller | IX.6: `InboxService.claim` / `markStatus`, called from an application service (S10) |
| G-54 | `apps/projector/src/projector.module.ts` registers tenancy's `ShopMembershipModel` (`SequelizeModule.forFeature`) in the app; the projector app must hold no models (X.1) | **R3**: a projector in the consuming domain keeps its own copy of the membership fields from `tenancy.*` events (S12 and others own the choice), or **R1** `tenancy.assertMember` where the process is shared |
| G-55 | `domains/catalog/infra/product-search.projector.ts:33-41` raw SQL on tenancy's `"Shop"` (sandbox shops) from a projector (D-12) | **R3**: the shop's sandbox flag is copied into the product document from `tenancy.*` events (S32 and S03 own it); until then **R1** `tenancy.getShopsByIds` (batch, DTO) |
| G-56 | Domain test modules register `SequelizeModule.forFeature([…, Outbox])` and query `"Outbox"` (`content/stories.e2e-spec.ts:16,104`, `fulfilment/pickup.e2e-spec.ts:20`, `chat/chat-sync.e2e-spec.ts:65`, `media/media.e2e-spec.ts:97`, `seller-onboarding/onboarding.e2e-spec.ts:140`) | Allowed (test code, IX.6) but replace with a shared test helper `outboxRowsFor(aggregateId)` exported from `@app/common/testing` so tests stop depending on the table layout |

## K. Suggested order for the implementation agent

1. Envelope rename and contracts schema (G-01, G-02) with codemod over producers and projectors; `TopicRegistry` (G-07); `append*` (G-04 to G-06); relay shape, ordering, parking, purge (G-08 to G-13).
2. Consumer framework: parsing, routing, declaration, transient versus permanent, DLQ record, redrive (G-16 to G-27).
3. Inbox service and migration (G-28 to G-30); sink strictness and counts (G-31 to G-35).
4. Read-your-writes and lag (G-36, G-38); rebuild, promote, rollback (G-37).
5. Task queue changes and `appendTask` (G-39 to G-43); transactional pipeline (G-44).
6. Metrics, logs, config (G-45, G-46, G-49); tests and the test stack (G-14, G-47, G-48); boundary clean-up (G-50 to G-56).

## N. Callers and tests to update for the BREAKING lines

- Envelope rename: every `defineEvent` call under `libs/domains/*/application/events/*` (about 15 files: orders, content, media, chat, fulfilment, billing, discovery, developer-platform, launch-events, seller-onboarding, assistant, catalog, marketing), every projector reading `event.eventName` or `event.version`, `ProductSearchProjector`, `projection-runner.e2e-spec.ts`.
- `KafkaTopicGroup` removal: `payments` (`payment.service.ts`, `payment-resolution.jobs.ts`, `payment.controller.ts`, `payment.e2e-spec.ts`), `catalog` (`drafts.service.ts`, `product.service.ts`, `product-cache-invalidator.projector.ts`, `product-search.projector.ts`), `community` (`product-feed.projector.ts`), `developer-platform` (`webhook-router.projector.ts`, `public-catalog.service.ts`), `orders` (`order-payment.listener.ts`), `catalog-sync` (`sync.service.ts`, `integration-sync.service.ts`, `integrations.workers.ts`, `catalog-import.service.ts`).
- `OutboxService.notify` callers (thin `{ productId }` legacy rows on `products.events`, and payment rows): `developer-platform/application/public-catalog.service.ts:139,186`, `payments/application/payment.service.ts:141,268,289,329`, `payments/infra/payment-resolution.jobs.ts:79`, `catalog-sync/application/sync.service.ts:88,113`, `catalog-sync/application/integration-sync.service.ts:141`, `catalog/application/product.service.ts:100`, `catalog/application/drafts.service.ts:133`. Each becomes a typed `append` of a state-carrying event (S05 owns the product events; S13 the payment ones).
- `deduplicationId` callers (rename to `dedupeId`): `developer-platform/infra/webhook-router.projector.ts:65`, `developer-platform/infra/webhook-workers.ts:41`.
- The list above of `KafkaTopicGroup` users came from a search cut at 20 files; re-run `grep -rn KafkaTopicGroup packages/backend` for the complete list before editing.
