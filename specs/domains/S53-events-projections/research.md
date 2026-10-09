# Research: S53 — decisions

No `NEEDS CLARIFICATION` remained; `questions.md` defaults are accepted. Decisions below settle implementation choices the spec leaves open.

## R-1 Envelope and contracts location
- **Decision**: envelope zod schema and fixture payload schemas in `packages/contracts`, re-exported by `events/event-envelope.ts`; `aggregateVersion` is the guard field, domains keep their named version equal to it.
- **Rationale**: VII.6/FR-007; sibling specs already write `{eventId, type, version, ...}`.
- **Alternatives**: keep schema in infrastructure (fails VII.6).

## R-2 Transaction joining
- **Decision**: `append` reads the active transaction through the S54 `getActiveTransaction()` (CLS); none active → `NoActiveTransactionError`. `appendStandalone`, claim, purge and requeue use `TransactionRunner.run`. `appendWithExecutor` takes a caller `query` function and opens nothing.
- **Rationale**: cross-spec rule 3. A grep of `events outbox projections kafka sqs idempotency` finds no `sequelize.transaction` and no `// S54 T037 audit` comment, so the direct-site count stays at zero.
- **Alternatives**: own transaction when none is active (today's `notify`) — a silent dual write.

## R-3 Relay
- **Decision**: keep claim-then-publish with a lease (`FOR UPDATE SKIP LOCKED … RETURNING`); claim in a short transaction, publish outside it, mark afterwards. Per-aggregate holding: rows whose aggregate has an earlier pending unparked row are skipped in the drain. Backoff is full jitter (base 1 s, cap 60 s) with an injected random source; park at 10 attempts or on a non-retryable broker error (message too large, unknown topic, authorization). One `sendBatch` per drain.
- **Rationale**: FR-014 to FR-017, questions LOCAL rows.
- **Alternatives**: advisory lock per aggregate (more locks, no gain).

## R-4 Same message from poller and Debezium
- **Decision**: row stores the envelope as JSONB; the poller sends the serialized envelope; the connector uses `table.expand.json.payload=true`, key from `aggregateId`, and headers `eventId`, `type`, `version`, `traceparent`. One helper defines the header field list, and `connector-config.spec` checks the connector against it.
- **Alternatives**: custom SMT (more to operate).

## R-5 Consumer offsets
- **Decision**: `autoCommit: false`, `eachBatch` with `eachBatchAutoResolve: false`; `resolveOffset` plus `commitOffsetsIfNecessary` only after the effects up to that offset; heartbeat during long batches; per-partition pause with timed resume on transient failure; sticky assignor (cooperative if the installed kafkajs supports it).
- **Rationale**: FR-028 to FR-030, FR-035, FR-036. Auto-commit can commit in-flight work (G-18).

## R-6 Failure classification
- **Decision**: `TransientError` / `SinkBackpressureError` pause and retry with backoff and never dead-letter; `PermanentError` and unclassified errors go through the attempt budget then the DLQ. Sinks wrap driver errors (timeout, ECONNRESET, ECONNREFUSED, throttling, Redis LOADING/BUSY, DynamoDB throughput exceeded, ClickHouse overload codes) into `TransientError`.

## R-7 Dead letters
- **Decision**: `<group>.dlq`, created at consumer registration (idempotent admin create); original bytes and key preserved; headers in `contracts/dead-letter.md`; reason built from codes and zod paths, never values. Redrive republishes to `x-source-topic` with `x-redrive-count + 1` and refuses at 3. A failed DLQ write leaves the offset uncommitted.

## R-8 Sink version guards
- **Decision**: Redis Lua applies only when `v > cur` and returns applied/duplicate/stale, with a `{v, deleted}` tombstone on delete; DynamoDB `ConditionExpression attribute_not_exists(v) OR v < :v` and classification on condition failure; Scylla uses the version as write timestamp with an explicit tie rule (equal = duplicate); ClickHouse uses `insert_deduplication_token` plus ReplacingMergeTree(version), read with `FINAL`; Elasticsearch uses `version_type: external` (strict).

## R-9 Elasticsearch sink (debt D-16)
- **Decision**: ship `EsVersionedSink` over the current product-index client; it moves with S32's generic client. `ProductSearchProjector` keeps group `search-indexer` so offsets carry over.

## R-10 Read-your-writes
- **Decision**: key `ryw:{consumer}:{aggregateType}:{aggregateId}` with 24 h TTL set by a max-and-expire Lua script. `resolve` order: caller's tenant check → validate `minVersion` → probe → jittered polls within the budget (clamped to 2,000 ms) → `readWriteModel()` or `pending`. Redis failure → immediate fallback.

## R-11 Replay and rebuild
- **Decision**: commands in `scripts/projections/` using kafkajs admin (`describeGroups`, `fetchTopicOffsets`, `setOffsets`). A shadow rebuild runs the same projector under group `<name>@<label>` into a new target; the active label is a single Redis key switched with one `SET`, the previous label is kept for rollback. Audit lines go to the structured logger.

## R-12 Task relay and transactional pipeline
- **Decision**: task rows are relayed with `dedupeId = row id` (FIFO) and the body is nulled after send. `TransactionalPipeline` uses the kafkajs transactional producer with `transactionalId = id`, `sendOffsets`, and a `read_committed` input.

## R-13 Tests without mocks
- **Decision**: faults via `test/fakes/tcp-fault-proxy.ts`; time via the S54 fake clock; randomness via an injectable `RandomSource`; `waitFor` helper, no fixed sleeps; fixture module in `events/testing/`.

## Caller checklist for T014 (collected 2026-10-09 by T001)

Baseline: `tsc --noEmit` clean; `check:boundaries` 0 errors, 62 warnings. Paths are relative to `packages/backend/libs/`.

`KafkaTopicGroup`:
- [ ] infrastructure/kafka/kafka-consumer.service.ts; infrastructure/outbox/{types.ts, outbox.model.ts, outbox-publisher.e2e-spec.ts}
- [ ] domains/payments/{application/payment.service.ts, payment.e2e-spec.ts, api/payment.controller.ts, infra/payment-resolution.jobs.ts}
- [ ] domains/catalog/{application/drafts.service.ts, application/product.service.ts, infra/product-search.projector.ts, infra/product-cache-invalidator.projector.ts}
- [ ] domains/developer-platform/{application/public-catalog.service.ts (2 sites), infra/webhook-router.projector.ts}
- [ ] domains/catalog-sync/{application/sync.service.ts (2), application/integration-sync.service.ts, application/catalog-import.service.ts, infra/integrations.workers.ts}
- [ ] domains/orders/infra/order-payment.listener.ts; domains/community/infra/product-feed.projector.ts

`OutboxService.notify` callers: catalog/product.service.ts:124, catalog/drafts.service.ts:211, catalog-sync/integration-sync.service.ts:270, catalog-sync/sync.service.ts:149,206, developer-platform/public-catalog.service.ts:229,341, payments/payment-resolution.jobs.ts:106, payments/payment.service.ts:152,286,311,359.

`deduplicationId`: developer-platform/infra/webhook-router.projector.ts:85, developer-platform/infra/webhook-workers.ts:50, infrastructure/sqs/sqs-task-queue.ts:57,79, infrastructure/sqs/task-queue.port.ts:7.

`wrapInOutbox`: infrastructure/outbox/outbox.service.ts:26, infrastructure/kafka/kafka-consumer.service.ts:69.

`DomainEventsService` injectors: content/stories.service.ts, fulfilment/pickup.service.ts, billing/billing.jobs.ts, auctions/auction.jobs.ts, auctions/bid-relay.service.ts, seller-onboarding/onboarding-session.service.ts, seller-onboarding/verification.service.ts, orders/order.service.ts, orders/checkout.service.ts, payments/ledger.service.ts.
