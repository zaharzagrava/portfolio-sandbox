# Implementation Plan: S53 — Events, outbox/CDC, projections, replay, read-your-writes

**Branch**: `S53-events-projections` | **Date**: 2026-10-09 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md`, `test-plan.md`, `gaps.md` (G-01 to G-56), `questions.md` (defaults accepted as written; none edited by a human).

## Summary

Rebuild the shared event backbone in `packages/backend/libs/infrastructure/{events,outbox,inbox,projections,kafka,sqs}` so that: events have one envelope (`type`, `version`, `aggregateVersion`) defined in `packages/contracts`; `OutboxService.append*` writes in the caller's transaction (or throws); the poller and Debezium publish the identical unwrapped message; the consumer framework validates, routes by `(type, version)`, separates transient from permanent failure, commits offsets after effects and dead-letters to `<group>.dlq` with reason codes; the inbox, strict version-guarded sinks, read-your-writes, replay/rebuild, `TaskQueue` and `TransactionalPipeline` follow the spec. Every `gaps.md` item is a work package below (WP1–WP9); the order is the one in gaps.md section K.

Approach: evolve the existing code in place (the lib already has relay lease/claim, runner, sinks, port), rename and tighten rather than rewrite, replace the BREAKING surfaces in one codemod pass so the tree compiles at each step, and prove each work package with the e2e/unit specs named in `test-plan.md`.

## Technical Context

**Language/Version**: TypeScript (strict), Node, NestJS; Rust gateway only as a row-contract consumer (S24 owns its change).

**Primary Dependencies**: NestJS, `@nestjs/sequelize` + sequelize-typescript, kafkajs (`createKafka` factory), AWS SDK SQS (ElasticMQ in tests), ioredis, zod, `fast-check`, OpenTelemetry, prom-client via the S54 metrics registry. S54 toolkit: `TransactionRunner.run` / `@Transactional`, injectable clock, `ShutdownRegistry`, validated config. S49 `JobsService` for the two purge jobs. S32 generic ES client (D-16; see research R-9).

**Storage**: Postgres 18 (`Outbox` extended, `ProcessedWebhookEvent` extended and re-owned as `infrastructure:inbox`; both via expand/contract migrations with `lock_timeout`), Kafka/Redpanda, SQS/ElasticMQ, Redis (docs, checkpoints), Elasticsearch, DynamoDB, Scylla, ClickHouse.

**Testing**: Jest e2e against `docker-compose.test.yaml` (plus opt-in Debezium profile), unit specs for pure logic, `fast-check`; run via `/opt/sdd/repo/scripts/sdd/test-spec.sh`. 108 scenarios mapped 1:1 in `test-plan.md`.

**Target Platform**: Linux server processes `apps/api`, `apps/worker`, `apps/projector`.

**Project Type**: backend infrastructure library (monorepo).

**Performance Goals**: projection lag p99 < 2 s at 1/2/4 instances on 100k events (SC-005, reported not gated); relay batch 100 every 2 s.

**Constraints**: payload ≤ 256 KiB; 500 in-flight per consumer; 10 s publish timeout; 30 s handler timeout; graceful stop ≤ 20 s; no network I/O in a DB transaction.

**Scale/Scope**: 56 gap items, ~15 producer files, ~25 projector classes, 8 `KafkaTopicGroup` caller domains. Connection-pool arithmetic (III.12): the relay uses one pooled connection per poll cycle (claim transaction, released before any publish — no network I/O inside the transaction), the inbox joins the consumer's transaction, so S53 adds at most `relay replicas × 1 + consumer concurrency per partition-sequential batch` connections inside `db_pool_max` (default 10); consumer batches write sinks sequentially per aggregate, and inbox/outbox transactions are short. No new pool is created.

## Constitution Check

| Rule | Status | How the plan meets it |
|---|---|---|
| I / X.5 layering, infra imports no domain | Pass | `KafkaTopicGroup` removed (G-07); topics come from `TopicRegistry` registered by domains; fixture module uses no domain; `check:boundaries` in gates. |
| III.2 transactions only via S54 toolkit | Pass | `append` joins the CLS transaction via `TransactionRunner`/`getActiveTransaction`; `appendStandalone`, `recordOnce` tests, relay claim and purge use `TransactionRunner.run`. Audit: no `sequelize.transaction` and no `// S54 T037 audit` comment exists in `events/outbox/projections/kafka/sqs/idempotency` (grep 2026-10-09), so none to migrate and none to add. |
| III.3 no network I/O in a transaction | Pass | Relay claims (short tx), commits, then publishes, then marks. |
| III.11 expand/contract migrations, `lock_timeout` | Pass | WP1/WP3 migrations only add columns/constraints (NOT VALID then VALIDATE for the row contract), owner rename is registry-only. |
| IV.3/IV.4 outbox/CDC only, event fields | Pass | `append` throws without a transaction; identical envelope across relays. |
| IV.5 idempotent, zod-validated consumers, DLQ | Pass | FR-025 declaration check; FR-026 validation; `<group>.dlq`. |
| IV.6 timeouts, one retry layer | Pass | FR-063: producer 10 s, handler 30 s, queue/redis/stores explicit; relay retries at relay layer only, consumer at framework layer only. |
| VII testing | Pass | All 108 scenarios; no `jest.spyOn` on producer (G-47): faults via TCP fault proxy; no fixed sleeps. |
| VIII.1 no payload in logs | Pass | Reason codes + schema paths only (G-46). |
| IX.5–IX.7 isolation | Pass | WP9 extends `check-table-ownership` to technical tables (G-51); domain raw `"Outbox"`/`"ProcessedWebhookEvent"` SQL replaced (see WP9 for sibling split). |
| X.1 composition holds no models | Pass with sibling follow-up | G-54 handled by sibling specs (see gaps.md follow-ups). |

Post-design re-check: no violations; Complexity Tracking empty.

## Work packages (every gaps.md item)

| WP | Gaps | Deliverables | Key tests |
|---|---|---|---|
| **WP1 Contract, append, topics** | G-01–G-07 | `packages/contracts/src/events/{envelope,...}.ts` (envelope schema, `index.ts` export); `defineEvent` rewrite (type regex, registry, `carries`, 256 KiB cap, `InvalidEventPayloadError`, `EventTooLargeError`, injected clock); `TopicRegistry`; `OutboxService.append/appendStandalone/appendTask/appendWithExecutor/requeueParked`, `NoActiveTransactionError`; migration adding row constraints (aggregate id NOT NULL, kind/status checks, attempts, parked reason, nextAttemptAt index); remove `DomainEventsService.record`, `notify`, `wrapInOutbox`, `KafkaTopicGroup`; codemod all `defineEvent` callers and listed `notify`/`deduplicationId` callers (gaps §N). | `events/outbox-append.e2e-spec.ts`, `events/event-definition.spec.ts`, `events/topic-policy.spec.ts`, `events/contracts-parity.spec.ts` |
| **WP2 Relay** | G-08–G-15 (G-14 test stack) | Relay publishes unwrapped envelope + headers; per-aggregate holding; park after 10 / non-retryable; full-jitter backoff via `@app/common/core/backoff` with scripted random; injected clock; mode validation; `outbox.purge-published` job; Debezium connector config (headers, outbox-only table, expand); `docker-compose.test.yaml` opt-in `cdc` profile; `KafkaProducerService` via `createKafka`, idempotent, `acks=-1`, 10 s timeout; `EventPublisher` (`publish`, `publishMany`); task relay to queue (G-42) with row id dedupe and body clearing; trace `traceparent`. | `outbox/outbox-relay.e2e-spec.ts`, `outbox-retention`, `outbox-tasks`, `outbox-cdc` (profile), `events/event-publisher`, `events/trace-propagation`, `backoff.spec`, `error-classification.spec`, `connector-config.spec`, `relay-config.spec` |
| **WP3 Inbox** | G-28–G-30, G-53 (service side) | `libs/infrastructure/inbox` (`InboxService.claim/markStatus/recordOnce/purge`), model + migration (status, attempts, claimedAt, handledAt; table name kept), ownership registry owner `infrastructure:inbox`, `inbox.purge` job. | `inbox/inbox.e2e-spec.ts` |
| **WP4 Consumer framework** | G-16–G-27 | Strict `parseEnvelope` (no legacy lift); `Projector` declaration (idempotency, coalesce guard, attempts, replayable, aggregateIdSchema, `handles` with upcasters); runner: manual offset commit, per-aggregate sequential, in-flight bound 500, handler timeout, transient vs permanent classification (`TransientError`, `PermanentError`, `SinkBackpressureError`), partition pause/backoff, dead-letter writer with header set + reason codes (guarded: no commit if DLQ unwritable), sticky assignor, `fromBeginning` only when `replayable`, graceful stop via `ShutdownRegistry`; lag/outcome metrics after success only; `projections:redrive` CLI; remove `KafkaConsumerService.consume` legacy path (G-27) once its payments callers are migrated (see Sibling follow-ups; the method stays until S13 lands, deprecated and with no new callers). | `projections/consumer-idempotency`, `consumer-failures`, `contract-evolution` e2e; `consumer-declaration`, `coalesce`, `upgrade-chain`, `error-classification` unit |
| **WP5 Sinks** | G-31–G-35 | Strict `{applied,duplicate,stale}` for Redis (Lua with tombstone), Dynamo, Cassandra (tie rule), ClickHouse (`dedupeToken`, transient wrapping); `EsVersionedSink` (R-9); `applyIfNewer`. | `projections/versioned-sinks.e2e-spec.ts`, `version-guard.spec.ts` |
| **WP6 Read-your-writes & lag** | G-36, G-38 | Expiring per-aggregate checkpoints (24 h, monotonic Lua), `ReadYourWrites.resolve` (budget, jittered polls, fallback/pending, `minVersion` validation, tenant-first, store-down fallback), `ConsumerLag.read`; fixture routes. | `projections/read-your-writes.e2e-spec.ts`, `read-your-writes-wait.spec.ts` |
| **WP7 Replay/rebuild** | G-37 | `projections:rebuild` (refuse live members, non-replayable, truncated history), `promote` (lag gate, verify, atomic switch, keep old), `rollback`, audit line, resume from committed offsets. | `projections/replay-rebuild.e2e-spec.ts` |
| **WP8 Task queue & pipeline** | G-39–G-41, G-43, G-44 | `TaskQueue` port: `dedupeId`, option validation (`InvalidEnqueueOptionsError`), `enqueueBatch → {sent, failed}`, `consume` with `bodySchema`, visibility extension, immediate DLQ, trace attributes, graceful stop; in-memory fake kept in parity; `TransactionalPipeline`; ClickHouse `dedupeToken`. | `sqs/task-queue.e2e-spec.ts`, `enqueue-options.spec.ts`, `projections/kafka-transactions.e2e-spec.ts` |
| **WP9 Observability, config, tests, boundaries** | G-45–G-50, G-51–G-56 | Metrics (AS-105 names, low cardinality), payload-free logs, validated config keys (relay interval/lease/attempts/retention, consumer budgets, wait budget, partitions) in `api-config.service.ts`; test stack; rewrite `outbox-publisher.e2e-spec` and `projection-runner.e2e-spec` (no `jest.spyOn` producer, no fixed sleeps, new field names); `ProjectionsModule.forProjectors(types, imports?)` provides the sinks each projector needs (G-50); `check-table-ownership` extended to technical tables with `--strict` (G-51); `outboxRowsFor` helper in `@app/common/testing` (G-56); static isolation scan. | `outbox/outbox-isolation.spec.ts`, `projections/observability.e2e-spec.ts` |

## Debt register (gaps.md §I)

D-8: S53 delivers the `Projector` + `forProjectors` host contract and fixture; domain barrels are fixed by each consuming capability. D-16: sink ships over the current ES client, moves with S32 (R-9). D-14: path supplied (`appendStandalone`), nothing else. D-6: not an S53 deliverable. No debt row is paid by editing a sibling spec.

## Sibling-spec follow-ups

Recorded in `gaps.md` under `## Sibling-spec follow-ups` (rule 1): S53 does not edit other specs or the other domains' production code beyond the mechanical codemod needed to keep the tree compiling (field renames, `KafkaTopicGroup` → registry string). Domain behaviour changes (G-51, G-52, G-53, G-54, G-55, payments flows) are handed to the owning capability.

## Project Structure

### Documentation

```text
specs/domains/S53-events-projections/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/   (envelope.md, outbox-row.md, relay-message.md, consumer-declaration.md, dead-letter.md, services.md)
└── tasks.md     (/speckit-tasks)
```

### Source code

```text
packages/contracts/src/events/            # envelope + fixture payload schemas (FR-007)
packages/backend/libs/infrastructure/
├── events/        define-event, event-envelope (re-export of contracts), topic-registry, event-publisher, testing/ (fixture module)
├── outbox/        outbox.service, outbox.model, relay (poller), purge job, backoff, error-classification, row contract
├── inbox/         inbox.service, inbox.model, purge job            (new lib, replaces idempotency's webhook table role)
├── kafka/         client factory, idempotent producer, consumer (legacy path deprecated)
├── projections/   runner, parser, projector, dead-letter, checkpoints, read-your-writes, consumer-lag, transactional-pipeline, sinks/
├── sqs/           task-queue port, adapter, in-memory fake, queue-metrics
packages/backend/scripts/projections/     rebuild, promote, rollback, redrive ; scripts/outbox/requeue
packages/backend/migrations/              expand-only migrations (outbox contract, inbox columns)
infra/debezium/ , docker-compose.test.yaml (cdc profile)
```

**Structure Decision**: extend the existing infrastructure lib directories; add `inbox/` as its own lib; contracts live in `packages/contracts`.

## Complexity Tracking

No violations to justify.
