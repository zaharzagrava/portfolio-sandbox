---
id: S53
title: Domain events, outbox/CDC → Kafka, idempotent versioned projections, replay, read-your-writes
kind: capability
status: draft
generated_at: e95ce81
depends_on: [S49, S54]
concepts: [outbox-task-queue, projection-and-replay, transaction-runner, job-scheduler-lease, idempotency-key, request-context, problem-json-errors, tenant-shop-rbac]
models: []
scope:
  - packages/contracts/src/events/**
---
# S53 - Domain events, outbox/CDC → Kafka, idempotent versioned projections, replay, read-your-writes

## Purpose
Domains need to say "this happened" and let other domains react without sharing a table. This capability is the shared event backbone: a typed event contract, a {{concept:outbox-task-queue}} written in the same transaction as the state change, a relay to Kafka, consumers that apply each event once in effect, replay, and read-your-writes. It owns no business data, and every read model it feeds can be rebuilt from the log.

## Entry points
- `append`, `appendStandalone` and `appendTask` on the outbox service: write event or task rows in the caller's transaction (`appendStandalone` needs none). See {{concept:transaction-runner}}.
- Framework-free append: lets non-Nest writers (the Lambda of S29, the Rust gateway of S24) write rows over a plain database connection.
- Outbox relay (poller on every replica, or Debezium CDC): publishes pending rows to `<aggregateType>.events`, and task rows to their queue. [code: infra/debezium/outbox-connector.json]
- Plain event producer: sends one validated envelope to Kafka with no database.
- Projection consumers: one consumer group per consumer, with a dead-letter topic `<consumer>.dlq`.
- Inbox: `claim(source, eventId)` for webhook-style handling, and `recordOnce(consumer, eventId)` inside a transaction.
- Read-your-writes helper: a read route accepts `minVersion` and answers `200`, `202` or `400`.
- Purge jobs for published outbox rows and for terminal inbox rows (single-run jobs, see {{cap:S49}}).
- Operator commands: `pnpm projections:rebuild` [code: packages/backend/scripts/projections/rebuild.ts], `pnpm projections:promote`, `pnpm projections:redrive` [code: packages/backend/scripts/projections/redrive.ts#parseRedriveArgs], `pnpm check:table-ownership --technical-only` [code: packages/backend/scripts/check-table-ownership.ts].
- Task queue `enqueue`, `enqueueBatch` and `consume`; transactional consume-transform-produce pipeline; `ConsumerLag.read(group)`.

## Rules
- **S53.R-01** Every event MUST be created from a typed definition whose payload passes its schema; a failing payload throws `InvalidEventPayloadError` naming the first failing path, never the value, and appends nothing. [proof: S53 AS-04] [code: packages/contracts/src/events/envelope.ts#eventEnvelopeSchema]
- **S53.R-02** An event type MUST be lowercase dotted (`a.b_c`), `(type, version)` MUST be unique, and `aggregateVersion` MUST be an integer from 0 to 2^53−1; otherwise a typed error is thrown and no event is created. [proof: S53 AS-10] [code: packages/contracts/src/events/envelope.ts#EVENT_TYPE_PATTERN]
- **S53.R-03** A serialized envelope above 256 KiB MUST be rejected with `EventTooLargeError`, and nothing is appended. [proof: S53 AS-07]
- **S53.R-04** `append` MUST write in the caller's transaction and reject with `NoActiveTransactionError` when none is active; a rollback leaves no outbox row. [proof: S53 AS-02, S53 AS-03]
- **S53.R-05** Events appended in one call MUST be written in one statement and keep their order per aggregate in the log. [proof: S53 AS-05]
- **S53.R-06** An event for an unregistered aggregate type MUST throw `UnregisteredAggregateTypeError`; a registered type publishes to `<aggregateType>.events`. [proof: S53 AS-11]
- **S53.R-07** A `latest-per-key` topic MUST be refused at startup with `TopicPolicyError` if any of its event definitions does not carry full aggregate state. [proof: S53 AS-12]
- **S53.R-08** No domain code MAY access the outbox or inbox tables except through this capability's exported services; a CI check enforces this. [proof: S53 AS-09] [code: packages/backend/scripts/check-table-ownership.ts]
- **S53.R-09** The relay MUST publish the envelope JSON unwrapped, keyed by `aggregateId`, with headers `eventId`, `type`, `version`, `traceparent`; the poller and CDC MUST produce identical messages. [proof: S53 AS-13, S53 AS-21]
- **S53.R-10** The relay MUST claim rows with a 30 s lease, so that two relays never publish the same row while the lease holds. [proof: S53 AS-16, S53 AS-20]
- **S53.R-11** Publication MUST be at least once: a crash between send and mark yields a duplicate with the same `eventId`, never a loss. [proof: S53 AS-15]
- **S53.R-12** A failed row MUST be retried with full-jitter backoff (base 1 s, cap 60 s) and MUST hold back later rows of the same aggregate. [proof: S53 AS-14, S53 AS-17]
- **S53.R-13** A row MUST be parked after 10 failed attempts, or at once for a non-retryable broker error; a parked row no longer blocks its aggregate. [proof: S53 AS-18, S53 AS-19]
- **S53.R-14** An invalid relay mode MUST fail startup, and in `poller` mode exactly one poller MUST run per process. [proof: S53 AS-23]
- **S53.R-15** The purge job MUST delete only published rows older than 7 days, in batches of at most 1,000. [proof: S53 AS-24]
- **S53.R-16** The shipped connector configuration MUST include only the outbox table, route by the row's topic and key by aggregate ID. [proof: S53 AS-22] [code: infra/debezium/outbox-connector.json]
- **S53.R-17** A consumer MUST declare `inbox`, `versionGuard` or `natural`, and group names MUST be unique; otherwise startup fails with `ConsumerDeclarationError`. [proof: S53 AS-43]
- **S53.R-18** A `versionGuard` consumer MUST apply an event only when its `aggregateVersion` is higher than the stored one; equal counts `duplicate`, lower counts `stale`. [proof: S53 AS-29, S53 AS-33, S53 AS-34, S53 AS-71]
- **S53.R-19** The inbox MUST record `(consumer, eventId)` in the effect's transaction, so concurrent duplicates yield one effect. [proof: S53 AS-28, S53 AS-31, S53 AS-32, S53 AS-49]
- **S53.R-20** Offsets MUST be committed only after the effects, so a disconnect causes redelivery and never loss. [proof: S53 AS-36, S53 AS-37]

## Behaviors
- **S53.B-01** Given aggregate A at version 3, when a transaction updates it to version 4 and appends `fixtures.item_changed` and commits, then exactly one pending outbox row exists. [proof: S53 AS-01]
- **S53.B-02** Given two concurrent transactions both updating A from 3 to 4, when both commit, then one fails with the aggregate's conflict error and only one outbox row remains. [proof: S53 AS-06]
- **S53.B-03** Given a writer with only a database connection, when it appends through the framework-free append, then the relay publishes the row like any other. [proof: S53 AS-08]
- **S53.B-04** Given the broker is unreachable, when the relay drains, then rows stay unpublished with `attempts` 1 and a future `nextAttemptAt`; they publish after the broker returns. [proof: S53 AS-14]
- **S53.B-05** Given A1 fails to publish, when the relay drains, then A2 and A3 wait while B1 publishes; the log later shows A1, A2, A3 in order. [proof: S53 AS-17]
- **S53.B-06** Given two relays and 100 pending rows, when both drain at once, then the log holds exactly 100 messages. [proof: S53 AS-16]
- **S53.B-07** Given events with versions 3, 1, 2, when the consumer processes them, then the read model holds version 3 and the checkpoint is 3. [proof: S53 AS-33]
- **S53.B-08** Given a deleted document at version 5, when an upsert at version 4 arrives, then the document stays deleted. [proof: S53 AS-42]
- **S53.B-09** Given a batch of 5 events whose third fails its schema, when processed, then the third is dead-lettered with `SCHEMA_INVALID` and the others apply. [proof: S53 AS-51]
- **S53.B-10** Given an event type the consumer does not handle, when it arrives, then it is counted `ignored`, its offset is committed and it is not dead-lettered. [proof: S53 AS-52]
- **S53.B-11** Given an event with a version above the consumer's highest, when it arrives, then it is dead-lettered with `UNSUPPORTED_VERSION`. [proof: S53 AS-53]
- **S53.B-12** Given a handler that always throws a permanent error, when the batch runs, then the event is attempted 3 times and dead-lettered with `HANDLER_FAILED`, and the offset passes it. [proof: S53 AS-57]
- **S53.B-13** Given the sink is unreachable for 30 s, when events arrive, then the partition pauses, nothing is dead-lettered, and all events apply in order afterwards. [proof: S53 AS-59]
- **S53.B-14** Given 4 dead letters, when an operator redrives, then each returns to its source topic with its original key. [proof: S53 AS-63]
- **S53.B-15** Given the read model at version 7, when the read route is called with `minVersion=7`, then it answers `200` with `X-Read-Source: read-model`. [proof: S53 AS-73]
- **S53.B-16** Given a projection stopped at version 6, when `minVersion=7` is requested, then after 500 ms the route answers `200` from the write model with `X-Read-Source: write-model`. [proof: S53 AS-75]
- **S53.B-17** Given a route configured for "pending", when the projection is behind, then it answers `202` with `Retry-After: 1`. [proof: S53 AS-76]
- **S53.B-18** Given an invalid `minVersion` (`-1`, `1.5`, `abc`), when the route is called, then it answers `400` problem+json without waiting. See {{concept:problem-json-errors}}. [proof: S53 AS-77]
- **S53.B-19** Given tenant B reads an aggregate of tenant A with `minVersion=1`, when the route runs, then it answers `404` like a missing ID and does not consult the checkpoint. See {{concept:tenant-shop-rbac}}. [proof: S53 AS-78]
- **S53.B-20** Given an active span at `append`, when the event is relayed and consumed, then the consumer's span has the same trace ID. See {{concept:request-context}}. [proof: S53 AS-27]

## Lifecycles
- Outbox row: pending → published (relay marks it), or pending → parked after 10 failed attempts or one non-retryable error. An operator requeues parked rows.
- Inbox claim: `RECEIVED` → `PROCESSED`, `IGNORED`, `UNMATCHED`, `REJECTED` or `FAILED`. A `FAILED` claim, or a `RECEIVED` claim older than the 5-minute lease, can be claimed again with attempts incremented. [proof: S53 AS-44, S53 AS-45, S53 AS-46, S53 AS-47]

## Owns
- Tables: the outbox table (events and tasks) and the inbox tables (`recordOnce` records and `claim` rows).
- Topics: `<aggregateType>.events` per registered aggregate type; `<consumer>.dlq` per consumer; the `<consumer>.redrive` group.
- Metrics: `outbox_pending`, `outbox_parked`, `dlq_total`, `dlq_write_failures_total`, `consumer_events_total`, `read_your_writes_total`.
- Configuration: relay mode (`poller` or `cdc`), lease (30 s), backoff, retention (7 days outbox, 30 days inbox), read budget (500 ms default, 2,000 ms max), checkpoint expiry (24 h), consumer attempt budget (3), handler timeout (30 s), concurrency cap (500). It validates all of them at startup.
- Code: `infra/debezium/outbox-connector.json`, `packages/contracts/src/events/`.

## Decisions
- The outbox is written in the state change's transaction, so an event exists if and only if the change committed.
- Delivery is at least once, and consumers de-duplicate, so a crash never loses an event.
- Only the outbox table is captured by CDC, and the poller and CDC send identical messages, so the mode is a configuration choice.
- Topics are per aggregate and keyed by `aggregateId`, so events of one aggregate keep their order.
- Read models can be rebuilt from the log; state-carrying events (`carries: state`) allow compaction and coalescing.
- The poller runs on every replica on a local ticker, not as a scheduled job (S49 FR-060).
- No domain touches another's tables; a CI check enforces this.

## Known gaps
- AS-61 and AS-62 (consumer-failures) and AS-63 to AS-65 are listed as tested, but R-20 covers offsets only; the concurrency cap of 500 (AS-61) has no rule above.
- Sink rules (Redis, Elasticsearch, DynamoDB, Cassandra, ClickHouse; AS-66 to AS-70, AS-72) have tests but no rule or behavior on this page.
- P2 scenarios AS-82 to AS-89 (replay, shadow rebuild, promote, rollback, lag) have tests, but this page does not state them as rules. The `x-redriven-count` header in AS-63 differs from `x-redrive-count` in `redrive.ts`; resolve this.
- P2 task-queue scenarios (AS-90 to AS-101), transactional pipeline (AS-102 to AS-104), observability (AS-105) and contract evolution (AS-107, AS-108) have tests but are not described here.
- AS-106 (no payload values in logs) has no test carrying a scenario id.
- AS-25, AS-26, AS-38 to AS-40, AS-80 and AS-81 have tests, but no rule here states them.
- The shipped `ledger.service.ts` and `bid-relay.service.ts` use `OutboxService`, but no scenario checks them.