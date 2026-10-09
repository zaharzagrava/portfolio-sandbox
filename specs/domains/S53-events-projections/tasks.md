# Tasks: S53 — Events, outbox/CDC, projections, replay, read-your-writes

**Input**: `spec.md`, `plan.md`, `test-plan.md` (AS-01..AS-108), `gaps.md` (G-01..G-56), `data-model.md`, `contracts/`, `research.md`, `questions.md` (defaults accepted).
**Tests**: required (constitution VII, test-plan.md). Every code task is preceded by the failing test task that proves it (test-first).

## Conventions

- `LIB` = `packages/backend/libs/infrastructure`. Run backend commands from `packages/backend`. Run specs with `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>` (condensed output; open the full log only if needed). Run the narrowest spec while developing, the whole capability suite once in the last phase. After 5 failed fixes of the same test, stop and write the blocker, attempts and hypothesis into `questions.md`.
- No `jest.spyOn` on the producer, no fixed sleeps (`waitFor` only), fake clock and scripted random for every lease/backoff/retention/timeout, faults via `test/fakes/tcp-fault-proxy.ts`. Every e2e test asserts the response/return value **and** persisted state.
- Transactions (rule 3): use `TransactionRunner.run` / `@Transactional`. Audit on 2026-10-09: no `sequelize.transaction` and no `// S54 T037 audit` comment exists in `events/outbox/projections/kafka/sqs/idempotency`; add none. If one appears in a file you touch, migrate it and delete the comment.
- Sibling specs are never edited; follow-ups already live in `gaps.md` under `## Sibling-spec follow-ups`. Domain files are touched only by the mechanical codemod (T014), names only, never behaviour.
- Marked **[BREAKING]** items follow `questions.md`; update callers listed in `gaps.md` §N.

## Phase 1: Setup

- [X] T001 Baseline: from `packages/backend` run `pnpm exec tsc --noEmit`, `pnpm check:boundaries`; run `grep -rn KafkaTopicGroup packages/backend`, `grep -rn "\.notify(\|deduplicationId\|wrapInOutbox\|DomainEventsService" packages/backend --include=*.ts` and save the complete caller lists (gaps §N says the original list was cut at 20) as a checklist section at the end of `specs/domains/S53-events-projections/research.md` for T014.
- [X] T002 [P] Add the opt-in `cdc` compose profile (Kafka Connect + Debezium Postgres connector, Redpanda reachable) to `docker-compose.test.yaml` (G-14); document start command in `infra/debezium/README.md`.
- [X] T003 [P] Create the fixture module skeleton `LIB/events/testing/fixtures.module.ts` (test code only, imports no domain): `fixtures` aggregate with a tenant-scoped table via a test-only migration/sync, event definitions, and a consumer per idempotency mechanism (inbox, version-guard, natural) — filled in by later tasks; plus `packages/contracts/src/events/fixtures.ts` for fixture payload schemas.
- [X] T004 [P] Add validated config keys to `packages/backend/libs/common/config/api-config.service.ts` (G-49, FR-064): relay mode/interval(2 s)/batch(100)/lease(30 s)/attempts(10)/retention(7 d), consumer batch/attempts(3)/backoff(200 ms–5 s)/handler timeout(30 s)/in-flight(500)/graceful stop(20 s), read-your-writes budget, checkpoint TTL(24 h), promotion gate, default partitions(12; 64 hot). Unit-test table in `LIB/outbox/relay-config.spec.ts` (create here, written first: `it.each` mode values; invalid value fails startup) — covers AS-23, then implement the validation.

## Phase 2: Foundational (blocks all stories)

- [X] T005 [P] Write failing `LIB/events/contracts-parity.spec.ts` (AS-108): envelope and fixture payloads parse with `packages/contracts` schemas; exported name `eventEnvelopeSchema`; fields exactly as in `contracts/envelope.md` (`eventId` UUIDv7, `type` lowercase dotted `a.b_c`, `version` int ≥ 1, `aggregateType`, `aggregateId`, `aggregateVersion` int 0..2^53−1, `occurredAt` ISO 8601 UTC, `traceparent?`, `payload` object).
- [X] T006 Create `packages/contracts/src/events/envelope.ts` and export from `packages/contracts/src/events/index.ts` and the package index (G-02, FR-007); `LIB/events/event-envelope.ts` re-exports it and drops the old `eventName`/`schemaVersion` fields (G-01 **[BREAKING]**).
- [X] T007 [P] Write failing `LIB/events/event-definition.spec.ts` (AS-04, AS-10; `it.each`): type pattern, duplicate `(type, version)` rejected, `aggregateVersion` bounds, 256 KiB cap (`EventTooLargeError`), `InvalidEventPayloadError` names schema paths and never values, injected clock for `occurredAt`, `carries: 'state' | 'delta'` marker.
- [X] T008 Rewrite `LIB/events/define-event.ts` (G-03): type regex, `(type, version)` registry, `carries`, size cap, typed errors, clock injected (no `new Date()` default).
- [X] T009 [P] Write failing `LIB/events/topic-policy.spec.ts` (AS-12): `latest-per-key` registration with a `carries: 'delta'` event is rejected; duplicate/unknown aggregate type rejects.
- [X] T010 Implement `LIB/events/topic-registry.ts` (`TopicRegistry.register({aggregateType, partitions: 12 | 64 hot, retention, cleanup})`, topic `<aggregateType>.events`, called at module init by owning domains) and export from `LIB/events/events.module.ts` (G-07, FR-004, FR-005).
- [X] T011 [P] Write failing `LIB/outbox/error-classification.spec.ts` (AS-19; `it.each` broker error → retryable or not) and `LIB/outbox/backoff.spec.ts` (AS-14; full-jitter bounds with `fast-check`, scripted random).
- [X] T012 Implement `LIB/outbox/error-classification.ts` and use the shared `@app/common/core/backoff` full-jitter helper with an injectable random source in `LIB/outbox/` (G-09, G-13).
- [X] T013 Migration `packages/backend/migrations/<timestamp>-outbox-row-contract.ts` (expand-only, `lock_timeout` set, III.11) for `Outbox` (G-06): add `kind` text CHECK (`event` \| `task`), `status` text CHECK (`pending` \| `published` \| `parked`), `attempts` int default 0, `parkedReason` text (code only, no payload), `topic` text NOT NULL, `aggregateId` text NOT NULL (message key), `aggregateType` text NOT NULL for events, `type` lowercase dotted CHECK for events, `payload` jsonb CHECK event payload has `eventId`; `leaseUntil`, `publishedAt` timestamptz; indexes: partial `(nextAttemptAt) WHERE status='pending'`, `(aggregateId, createdAt)`, partial `(publishedAt) WHERE status='published'`. New CHECKs `NOT VALID`; legacy `extra`/`error` stay. Update `LIB/outbox/outbox.model.ts` and `types.ts`.
- [X] T014 Codemod **[BREAKING]** (G-01, G-07, gaps §N): rename envelope fields in all `defineEvent` callers under `libs/domains/*/application/events/*`, every projector reading `event.eventName`/`event.version`, `ProductSearchProjector`, `ProjectionCheckpoints`, `coalesceLatest`; replace `KafkaTopicGroup` uses with registry topic strings and register aggregate types (`TopicRegistry`) where the enum was used; rename `deduplicationId` → `dedupeId` in `developer-platform/infra/webhook-router.projector.ts:65` and `webhook-workers.ts:41`; replace `OutboxService.notify` callers with names-only compile fix (behaviour moves to siblings per gaps follow-ups). Then delete `KafkaTopicGroup` from `LIB/outbox/outbox.model.ts`. Verify `tsc --noEmit` and `check:boundaries` pass.

**Checkpoint**: tree compiles; contract, definition, registry specs green.

## Phase 3: User Story 1 — State change and event commit together (P1) 🎯 MVP

**Independent test**: `LIB/events/outbox-append.e2e-spec.ts` green (AS-01..AS-08, AS-11).

- [X] T015 [US1] Write failing `LIB/events/outbox-append.e2e-spec.ts` (top-level describe names the feature) for AS-01 (commit: row + envelope fields), AS-02 (rollback → zero rows), AS-03 (no transaction → `NoActiveTransactionError`; `appendStandalone` writes one row), AS-04 (invalid payload, nothing written), AS-05 (three events one statement, relay order), AS-06 (`Promise.all` two conditional updates → one row), AS-07 (256 KiB + 1 rejected), AS-08 (framework-free raw conforming insert accepted; null `aggregateId`, unknown `kind`/`status`, payload without `eventId` rejected by the database), AS-11 (unregistered type rejected; registered goes to `<type>.events`). Use `TransactionRunner.run` in the fixture.
- [X] T016 [US1] Implement `OutboxService.append/appendStandalone/appendTask/appendWithExecutor/requeueParked` and `NoActiveTransactionError` in `LIB/outbox/outbox.service.ts` (G-04, G-05, G-06; join the CLS transaction via `TransactionRunner`/`getActiveTransaction`; clock injected for `nextAttemptAt`; `append` and `appendTask` throw outside a transaction; multi-event append is one INSERT statement). Remove `OutboxService.notify`, `wrapInOutbox`, and `DomainEventsService.record` (and `LIB/events/domain-events.service.ts` if empty) **[BREAKING]**.
- [X] T017 [US1] Fixture routes/services in `LIB/events/testing/` that append inside a transaction so T015 can drive them; make T015 green.

## Phase 4: User Story 2 — Events reach the log reliably, in order (P1)

**Independent test**: `outbox-relay`, `outbox-retention`, `event-publisher`, `trace-propagation` specs green; `outbox-cdc` green with the `cdc` profile.

- [X] T018 [P] [US2] Write failing `LIB/outbox/outbox-relay.e2e-spec.ts`: AS-13 (key `aggregateId`, unwrapped envelope value, headers `eventId`/`type`/`version`/`traceparent`, published mark), AS-14 (broker refuses via fault proxy, attempts, jitter window with scripted random, recovery), AS-15 (mark fails after send → two messages same `eventId`), AS-16 (two relays, 100 rows, no duplicate), AS-17 (A1 fails, A2/A3 held, B1 published, order on log), AS-18 (park at 10, metric, log without payload, no longer blocks, `requeueParked`), AS-19 (non-retryable parks at once), AS-20 (lease at 29 s vs 31 s with fake clock). Replaces `outbox-publisher.e2e-spec.ts` (deleted in T060).
- [X] T019 [US2] Rework `LIB/outbox/outbox-publisher.service.ts` (G-08–G-10, G-12, G-13): publish the envelope itself + headers, key = `aggregateId` only (drop `payload.idempotency_key`/row-id fallback), per-aggregate holding within a drain, park after 10 attempts or non-retryable, full-jitter backoff, injected clock, one `sendMany` per topic per drain, claim transaction short and committed **before** any publish (no network I/O in a transaction), startup validation of relay mode. **[BREAKING]**
- [X] T020 [P] [US2] Write failing `LIB/events/event-publisher.e2e-spec.ts` (AS-25 validation, keying, hang → `PublishTimeoutError`, no database call; AS-26 dropped acknowledgement → one copy on the topic) and `LIB/events/trace-propagation.e2e-spec.ts` (AS-27: same trace ID producer → consumer with in-memory exporter). *(event-publisher spec done; the AS-27 spec needs the runner's trace extraction and is written with T031/T032.)*
- [X] T021 [US2] Rework `LIB/kafka/kafka-producer.service.ts` to use `createKafka`, idempotent producer, `acks=-1`, 10 s timeout (G-15 **[BREAKING]**); add `LIB/events/event-publisher.ts` (`publish`, `publishMany`; caller-supplied stable `eventId`; validates envelope; `traceparent` header).
- [X] T022 [P] [US2] Write failing `LIB/outbox/outbox-retention.e2e-spec.ts` (AS-24: published only, batches of 1,000, second run no-op, job registered).
- [X] T023 [US2] Implement the `outbox.purge-published` job (7 d, 1,000-row batches via `TransactionRunner.run`) registered with S49 `JobsService` in `LIB/outbox/` (G-11, FR-019). The poller stays on a local ticker, not a job.
- [X] T024 [P] [US2] Write failing `LIB/outbox/connector-config.spec.ts` (AS-22: parses `infra/debezium/outbox-connector.json`) and `LIB/outbox/outbox-cdc.e2e-spec.ts` (AS-21, `cdc` profile: same topic, key, value, headers as the poller; poller off). *(AS-22 spec green; the AS-21 e2e is gated on `S53_CDC=1` and was **not run**: the Debezium image cannot be pulled in the sandbox, see quickstart "Ops artifacts".)*
- [X] T025 [US2] Update `infra/debezium/outbox-connector.json` (outbox table only, unwrapped envelope, headers `eventId`/`type`/`version`/`traceparent`, route to `<aggregateType>.events`, expand) and fix the false "same shape" claim and purge note in `infra/debezium/README.md` (G-08, G-14, FR-018).

## Phase 5: User Story 3b — Inbox service (P1)

**Independent test**: `LIB/inbox/inbox.e2e-spec.ts` green (AS-44..AS-49).

- [X] T026 [US3b] Write failing `LIB/inbox/inbox.e2e-spec.ts`: AS-44 claim new pair → `CLAIMED`; AS-45 two claims `Promise.all` → one `CLAIMED`, one `DUPLICATE_IN_PROGRESS`; AS-46 terminal statuses → `DUPLICATE_DONE`; AS-47 `FAILED` and `RECEIVED` older than 5 min re-claimable (fake clock); AS-48 purge terminal rows older than 30 days only, in batches; AS-49 `recordOnce` rolls back with the caller's transaction and commits with it.
- [X] T027 [US3b] Migration `packages/backend/migrations/<timestamp>-inbox-columns.ts` (expand-only, `lock_timeout`) on `ProcessedWebhookEvent` (table name kept, IX.2): `source`, `eventId`, `status` (`RECEIVED|PROCESSED|IGNORED|UNMATCHED|REJECTED|FAILED`), `attempts`, `claimedAt`, `handledAt`, `createdAt`; unique `(source, eventId)` (G-28, G-29).
- [X] T028 [US3b] Create `LIB/inbox/{inbox.module,inbox.service,inbox.model}.ts`: `claim(provider, eventId)` = insert-or-conditional-reclaim in one statement; `markStatus`; `recordOnce(consumer, eventId)` with `source = consumer`, joining the caller's transaction via `TransactionRunner`; `inbox.purge` job (30 d, batches). Change owner in `packages/backend/libs/.../db/ownership.ts:170` (`infrastructure:idempotency` → `infrastructure:inbox`) and update `docs/architecture/domain-map.md` only if it disagrees (G-29, G-30). The raw SQL in `orders/api/stripe-webhook.controller.ts` is handed to S10 (G-53 sibling follow-up already recorded).

## Phase 6: User Story 3 — A consumer's effect happens once (P1)

**Independent test**: `projections/consumer-idempotency.e2e-spec.ts` + unit specs green (AS-28..AS-43).

- [X] T029 [P] [US3] Write failing unit specs `LIB/projections/consumer-declaration.spec.ts` (AS-41 coalesce on a `carries: 'delta'` event fails startup; AS-43 missing `idempotency` mechanism, duplicate group `name`) and `LIB/projections/coalesce.spec.ts` (AS-40 `fast-check`: result is the per-aggregate maximum `aggregateVersion`).
- [X] T030 [US3] Rework `LIB/projections/projector.ts` and `projections.module.ts` (G-23): declaration `{name, idempotency: 'inbox'|'version-guard'|'natural', coalesce?, attempts?, replayable?, aggregateIdSchema?, handles: [{type, version, schema, upcast?, handle}]}`; startup fails on missing mechanism, duplicate `name`, `coalesce` on a delta event; `ProjectionsModule.forProjectors(types, imports?)` provides the sinks each projector needs (G-50).
- [X] T031 [US3] Write failing `LIB/projections/consumer-idempotency.e2e-spec.ts` with fixture consumers (T003): AS-28 inbox consumer delivered twice → one effect; AS-29 version guard (same `eventId`; different `eventId` same version); AS-30 natural consumer; AS-31 throw after effect → nothing persists, retry once; AS-32 two instances, same `eventId`, `Promise.all`; AS-33 versions 3,1,2 → 3 with `stale` counts; AS-34 equal version = `duplicate`; AS-35 no overlap per aggregate in 200 events; AS-36 throw once, retry, offset passes only after success; AS-37 connection cut before/after the effect (fault proxy), committed offset, redelivery; AS-38 second instance joins, one owner per partition, 1,000 events once; AS-39 two groups, one slowed; AS-40 30 events → 1 call with counts; AS-42 delete v5, late upsert v4, upsert v6.
- [X] T032 [US3] Rework `LIB/projections/projection-runner.service.ts` (G-18, G-24, G-25, G-26): `autoCommit: false`, manual commit after effects only (**[BREAKING]**), per-aggregate sequential handling, sticky assignor, coalesce only for declared-safe projectors, `fromBeginning` only when `replayable`, lag recorded only after success (coalesced-away events counted `duplicate`/`coalesced` not applied), clock injected (no `Date.now()`), `outcome` counter.

## Phase 7: User Story 4 — Bad messages and sick stores do not stop the line (P1)

**Independent test**: `consumer-failures.e2e-spec.ts`, `error-classification.spec.ts`, `upgrade-chain.spec.ts` green (AS-50..AS-65, AS-54).

- [X] T033 [P] [US4] Write failing unit specs `LIB/projections/error-classification.spec.ts` (AS-59: `it.each` error → transient or permanent per `contracts/dead-letter.md`; unclassified = permanent) and `LIB/projections/upgrade-chain.spec.ts` (AS-54: `it.each` v1→v2→v3 paths, missing step).
- [X] T034 [US4] Write failing `LIB/projections/consumer-failures.e2e-spec.ts`: AS-50 three malformed shapes, batch continues; AS-51 third of five invalid, reason holds paths not values; AS-52 unknown type ignored, offset committed; AS-53 newer version dead-lettered `UNSUPPORTED_VERSION`; AS-54 v1 upgraded to v2; AS-55 non-UUID aggregate ID `INVALID_AGGREGATE_ID`; AS-56 dead-letter bytes identical + full header set (`x-source-topic`, `x-source-partition`, `x-source-offset`, `x-consumer`, `x-dlq-reason-code`, `x-dlq-reason` ≤ 500 chars, `x-attempts`, `x-failed-at`); AS-57 3 attempts then `HANDLER_FAILED`, partition continues; AS-58 budget 6 → six invocations; AS-59 30 s sink outage via fault proxy → zero dead letters; AS-60 `SinkBackpressureError` pauses 2 s, other partitions flow; AS-61 5,000 events never more than 500 in the handler; AS-62 dead-letter topic unwritable → offset held, `dlq_write_failures_total`; AS-63 redrive four messages, fourth refused at `x-redrive-count` 3; AS-64 stop mid-batch, committed offset, ≤ 20 s; AS-65 hung handler, 30 s timeout, no rebalance.
- [X] T035 [US4] Rewrite `LIB/projections/envelope-parser.ts` (G-16 **[BREAKING]**): strict `parseEnvelope`, no legacy lift; anything not an envelope → `INVALID_ENVELOPE`. Add `(type, version)` routing in the runner with payload validation, unknown-type skip (counted `ignored`), newer-version dead letter, upcast chain (G-17).
- [X] T036 [US4] Add error classes `TransientError`, `PermanentError`, `SinkBackpressureError(retryAfterMs)` in `LIB/projections/errors.ts` and classification logic; runner changes in `projection-runner.service.ts` (G-19 **[BREAKING]**, G-20): transient → pause partition + full-jitter backoff 200 ms–5 s, never dead-letter; permanent/unclassified → per-consumer attempt budget (default 3) then DLQ; handler timeout 30 s (transient); in-flight bound 500; graceful stop via `ShutdownRegistry` (≤ 20 s).
- [X] T037 [US4] New `LIB/projections/dead-letter.ts` (G-21, G-46): writes `<group>.dlq` with original key/value bytes and the header set from `contracts/dead-letter.md`; reason text from error class + schema paths only (never values); topic created by the framework; if the DLQ write fails, do not commit the offset and increment `dlq_write_failures_total`.
- [X] T038 [US4] Create `packages/backend/scripts/projections/redrive.ts` (`projections:redrive --consumer <name> [--limit n]`, increments `x-redrive-count`, refuses at 3) and register the command in `packages/backend/package.json` (G-22).
- [X] T039 [US4] Deprecate `LIB/kafka/kafka-consumer.service.ts` `consume` (G-27): mark `@deprecated`, no new callers, remove the `wrapInOutbox` dependency; it stays until S13 migrates payments (sibling follow-up already in gaps.md).

## Phase 8: User Story 5 — A read model is never made older (P1)

**Independent test**: `versioned-sinks.e2e-spec.ts`, `version-guard.spec.ts` green (AS-66..AS-72).

- [X] T040 [P] [US5] Write failing `LIB/projections/version-guard.spec.ts` (AS-71: `it.each` pairs; `fast-check` any permutation converges to the maximum).
- [X] T041 [US5] Implement pure `applyIfNewer(stored, incoming) → 'applied'|'duplicate'|'stale'` in `LIB/projections/sinks/apply-if-newer.ts`, exported for domain tables (G-35, FR-044).
- [X] T042 [US5] Write failing `LIB/projections/versioned-sinks.e2e-spec.ts`: AS-66 Redis 200 racing pairs; AS-67 Elasticsearch 3,2,3 and bulk of 100; AS-68 DynamoDB conditional put; AS-69 Scylla version timestamp (tie rule); AS-70 ClickHouse duplicate batch with `dedupeToken` and stale version, read with `FINAL`; AS-72 fail on the 4th write, retry batch, same final state. Each sink returns `{applied, duplicate, stale}`.
- [X] T043 [US5] Make sinks strict **[BREAKING]** (G-31, G-32, G-34): `LIB/projections/sinks/redis-doc.sink.ts` Lua applies only strictly greater, returns the three counts, delete writes tombstone `{v, deleted: true}` keeping `v`; `dynamo-versioned.sink.ts` guard `<` not `<=`; `cassandra-versioned.sink.ts` tie rule; `clickhouse.sink.ts` `insert(table, rows, {dedupeToken})` and wraps driver errors in `TransientError`.
- [X] T044 [US5] Create `LIB/projections/sinks/es-versioned.sink.ts` `EsVersionedSink` over the current product-index client with external versioning applying only strictly greater (G-33, D-16/R-9; moves with S32); wire into `forProjectors`.

## Phase 9: User Story 6 — A writer sees their own write (P1)

**Independent test**: `read-your-writes.e2e-spec.ts` + `read-your-writes-wait.spec.ts` green (AS-73..AS-81).

- [X] T045 [P] [US6] Write failing `LIB/projections/read-your-writes-wait.spec.ts` (AS-81, frozen clock: reached, timeout, unavailable, budget clamp, jitter bounds, replica probe).
- [X] T046 [US6] Write failing `LIB/projections/read-your-writes.e2e-spec.ts` using fixture HTTP routes via `supertest` through the production pipe/filter/prefix: AS-73 caught up, no wait, header; AS-74 catch-up at 200 ms; AS-75 projector stopped → fallback to write model; AS-76 `202` with `Retry-After` and body; AS-77 `it.each` malformed `minVersion` → `400`, no wait; AS-78 other tenant `404` identical to missing, checkpoint untouched; AS-79 checkpoint store down (fault proxy) → fallback; AS-80 7,5,9 → 9, expiry after 24 h (fake clock).
- [X] T047 [US6] Rework `LIB/projections/read-your-writes.ts` and checkpoints (G-36 **[BREAKING]**): one Redis key `ryw:{consumer}:{aggregateType}:{aggregateId}` → highest `aggregateVersion`, TTL 24 h, monotonic Lua; record for every handled/coalesced/skipped event; `ReadYourWrites.resolve` (budget, jittered polls, injected clock, tenant check first, `minVersion` validation, store-down → fallback, `read-model`/`write-model`/`pending` source) replaces `waitFor`; fixture routes in `LIB/events/testing/`.

## Phase 10: User Story 7 — Rebuild or replace a read model without downtime (P2)

**Independent test**: `replay-rebuild.e2e-spec.ts` green (AS-82..AS-89).

- [X] T048 [US7] Write failing `LIB/projections/replay-rebuild.e2e-spec.ts`: AS-82 in-place replay, content hash equal; AS-83 live member → `GROUP_ACTIVE`, offsets unchanged; AS-84 shadow v2, promotion refused until caught up then allowed, atomic switch; AS-85 rollback to v1; AS-86 stop at 400, resume, once in effect; AS-87 `NOT_REPLAYABLE`, override with audit line; AS-88 truncated history refused, compacted topic rebuilt; AS-89 `ConsumerLag.read` lag 40 then 0, unknown group.
- [X] T049 [US7] Implement `LIB/projections/consumer-lag.ts` `ConsumerLag.read(group) → {totalLag, caughtUp, perPartition}` (committed vs end offsets; negative clamped to 0) (G-38) and rework `packages/backend/scripts/projections/rebuild.ts` (G-37 **[BREAKING]**: refuse live members, non-replayable, truncated history; resume from committed offsets; audit line) plus new `promote.ts` (lag gate, verify, atomic switch of `projection:active:{name}`, keep `…:previous`) and `rollback.ts`; register commands in `package.json`.

## Phase 11: User Story 8 — "Do this once" travels as a single-consumer task (P2)

**Independent test**: `outbox-tasks`, `task-queue` e2e and `enqueue-options` unit green (AS-90..AS-101).

- [X] T050 [P] [US8] Write failing `LIB/sqs/enqueue-options.spec.ts` (AS-92: `it.each` negative, fractional, 901, delay with FIFO group → `InvalidEnqueueOptionsError`).
- [X] T051 [P] [US8] Write failing `LIB/sqs/task-queue.e2e-spec.ts` (ElasticMQ; also run against the in-memory fake for parity — G-43): AS-92 2 s delay delivered once; AS-93 FIFO dedupe, group order, failing group isolated; AS-94 concurrency 4, 15 s handlers, visibility extension; AS-95 `receiveCount` 2,3 then DLQ; AS-96 invalid body → DLQ immediately, handler not called; AS-97 duplicate delivery with `recordOnce`, one effect; AS-98 `stop()` waits for in-flight; AS-99 25 in chunks of 10, one rejected, `{sent, failed}` lists it; AS-100 event delivered twice → one message per recipient; AS-101 same trace ID through attributes.
- [X] T052 [US8] Rework `LIB/sqs/task-queue.port.ts`, `sqs-task-queue.ts`, `in-memory-task-queue.ts` (G-39–G-41 **[BREAKING]**): `dedupeId` (was `deduplicationId`), validate `delaySeconds` ≤ 900 / integer / not with FIFO group (`InvalidEnqueueOptionsError`, never silently dropped), `enqueueBatch → {sent, failed}`, `consume(…, {bodySchema})` with immediate dead-letter on invalid body, visibility extension, `receiveCount`, trace attributes, graceful stop.
- [X] T053 [P] [US8] Write failing `LIB/outbox/outbox-tasks.e2e-spec.ts` (AS-90 task commit sends with row ID as dedupe ID; rollback sends nothing; AS-91 body cleared after send, kept after failure).
- [X] T054 [US8] Implement the task relay in `LIB/outbox/outbox-publisher.service.ts` / `LIB/outbox/task-relay.ts` (G-42): `kind='task'` rows go to the named queue with row id as `dedupeId`, `traceparent` attribute, body set to null after send; same attempts/parking rules.

## Phase 12: User Story 9 — Consume, transform, produce exactly once (P2)

**Independent test**: `kafka-transactions.e2e-spec.ts` green (AS-102..AS-104).

- [X] T055 [US9] Write failing `LIB/projections/kafka-transactions.e2e-spec.ts`: AS-102 10 in, 3 out, `read_committed` reader; AS-103 abort invisible, restart yields once; AS-104 two instances same transactional identity, older fenced.
- [X] T056 [US9] Implement `LIB/projections/transactional-pipeline.ts` `TransactionalPipeline.run` (stable transactional id, offsets sent in the transaction, fencing) (G-44; marketing click aggregator move is S36's, already in follow-ups).

## Phase 13: User Story 10 — Operable and healthy (P2)

**Independent test**: `observability.e2e-spec.ts` green (AS-105, AS-106).

- [X] T057 [US10] Write failing `LIB/projections/observability.e2e-spec.ts`: AS-105 scrape names (`outbox_pending`, oldest age, `outbox_parked`, published, failures, `consumer_events_total{outcome}`, `dlq_total`, `consumer_paused_total`, `read_your_writes_total`, `projection_lag_seconds`, queue depth/age) with labels and no ID-like label values; AS-106 captured log lines hold no payload value, token or address.
- [X] T058 [US10] Implement metrics via the S54 registry in the relay, runner, read-your-writes and `LIB/sqs/queue-metrics.service.ts` under the AS-105 names (G-45); replace raw error-message logging with reason codes + schema paths in `projection-runner.service.ts` and `outbox-publisher.service.ts` (G-46).

## Phase 14: User Story 11 — Contracts evolve without breaking readers (P2)

- [X] T059 [US11] Write failing `LIB/projections/contract-evolution.e2e-spec.ts` (AS-107: extra field ignored; missing required field dead-lettered `INVALID_PAYLOAD`), then fix any gap in `projection-runner.service.ts` / zod schemas (tolerant of additional fields, strict on required).

## Phase 15: Polish, boundaries and existing-test migration

- [X] T060 Replace `LIB/outbox/outbox-publisher.e2e-spec.ts` and `LIB/projections/projection-runner.e2e-spec.ts` (G-47): delete them once their scenarios are covered by T018/T031/T034/T046 (no `jest.spyOn` producer, no fixed `setTimeout(1_000)`, new field names, no seeds with legacy idempotency-key rows).
- [X] T061 Confirm every file in `events/`, `kafka/`, `sqs/` has a spec and each non-Redis sink is covered (G-48): list uncovered files, add missing specs if any remain after T015–T059.
- [X] T062 [P] Write failing `LIB/outbox/outbox-isolation.spec.ts` (AS-09): static scan of `libs/domains` for `"Outbox"` / `"ProcessedWebhookEvent"` SQL, models and associations; allowed: test helper imports.
- [X] T063 Extend `packages/backend/scripts/check-table-ownership.ts` to flag any reference to a technical table (`infrastructure:*` owner) outside its owning lib, with `--strict` (G-51 check, SC-008); add the `pnpm check:table-ownership --strict` script in `package.json`. The remaining violations in domains (`media-processor.ts:70`, `catalog-import.service.ts:217`, `stripe-webhook.controller.ts:49`) are handed to S29, S07, S10 (G-51–G-53 sibling follow-ups already in `gaps.md`); make the isolation scan and the `--strict` gate allow-list exactly those three files with a comment naming the owner spec so the gate is green now and fails on any new reference.
- [X] T064 [P] Add `outboxRowsFor(aggregateId)` helper exported from `@app/common/testing` (G-56) and use it in a new fixture test; the domain tests listed in G-56 migrate under their own specs (follow-up already recorded).
- [X] T065 Record handled-by-sibling items G-54 (projector app `ShopMembershipModel`, S12) and G-55 (`product-search.projector.ts` raw `"Shop"` SQL, S32) in `gaps.md` by confirming the `## Sibling-spec follow-ups` bullets exist; no code change in S53. Also D-8: ensure `forProjectors` host contract is documented in `contracts/services.md` (G-50, FR-040).
- [X] T066 Verify the unverified criteria: `quickstart.md` "Ops artifacts" lists SC-001, SC-004, SC-005, SC-006 and `specs/UNVERIFIED.md` has one `not run` row per criterion (already present; confirm no duplicate rows, none described as verified). SC-002, SC-003, SC-007, SC-008 are proven by tests (AS-28..34/66..70, AS-50/51/59, AS-89/105, AS-09).
- [X] T067 Final gates from `packages/backend`: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm check:boundaries`, `pnpm check:table-ownership --strict`; confirm direct `sequelize.transaction` count in `libs/infrastructure/{events,outbox,inbox,projections,kafka,sqs}` is 0.
- [X] T068 Run the whole capability suite once: `/opt/sdd/repo/scripts/sdd/test-spec.sh libs/infrastructure/events`, `…/outbox` (cdc spec only with the profile), `…/inbox`, `…/projections`, `…/sqs`; every AS-01..AS-108 passes once. Report any failure honestly.

## Gap coverage

G-01 T006/T014 · G-02 T006 · G-03 T008 · G-04–G-06 T013/T016 · G-07 T010/T014 · G-08 T019/T025 · G-09 T012/T019 · G-10 T019 · G-11 T023 · G-12 T019 · G-13 T012/T019 · G-14 T002/T025 · G-15 T021 · G-16 T035 · G-17 T035 · G-18 T032 · G-19 T036 · G-20 T036 · G-21 T037 · G-22 T038 · G-23 T030 · G-24 T032 · G-25 T032 · G-26 T032 · G-27 T039 · G-28–G-30 T027/T028 · G-31 T043 · G-32 T043 · G-33 T044 · G-34 T043 · G-35 T041 · G-36 T047 · G-37 T049 · G-38 T049 · G-39–G-41 T052 · G-42 T054 · G-43 T051 · G-44 T056 · G-45 T058 · G-46 T037/T058 · G-47 T060 · G-48 T061 · G-49 T004 · G-50 T030/T065 · G-51 T063 · G-52 T063 (S07) · G-53 T028/T063 (S10) · G-54 T065 (S12) · G-55 T065 (S32) · G-56 T064.

## Dependencies and order

- Phase 1 → Phase 2 (blocks all). US1 (Phase 3) before US2 (relay reads rows written by `append`). US2 and US3b independent after US1. US3 needs Phase 2 + Kafka producer (T021). US4 needs US3 (runner). US5 needs T030. US6 needs US3 (checkpoints in the runner). US7 needs US3 and US6 (`ConsumerLag`, replayable). US8 needs US2 (task relay) and US3b (`recordOnce`). US9 needs T021. US10 needs US2–US6. US11 needs US4.
- Parallel `[P]` tasks touch different files; within a story, the test task always precedes its code task.

## Implementation strategy

MVP = Phases 1–3 (contract, topics, append) → then US2 (relay) for end-to-end outbox → US3b/US3/US4/US5 (P1 consumer side) → US6 → P2 stories. Commit per phase with the tree compiling.
