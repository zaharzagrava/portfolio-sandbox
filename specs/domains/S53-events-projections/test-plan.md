# Test Plan: S53 — Events, outbox/CDC, projections, replay, read-your-writes (domain `infrastructure`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (AS-01 to AS-108), each proven at the lowest layer that can prove it. A dash means that layer does not test the scenario.

- API e2e files live under `packages/backend/libs/infrastructure/<lib>/`. Each file's top-level `describe` names its feature (VII.8). The capability is a library, so the e2e specs boot a Nest app from the real lib modules plus a **fixture module** (test code only, in `libs/infrastructure/events/testing/`): a `fixtures` aggregate with a tenant-scoped table, its event definitions and contract schemas, consumers for each idempotency mechanism, and, for read-your-writes, real HTTP routes called with `supertest` through the production pipe, filter, prefix and interceptors. The fixture imports no domain (X.5).
- Engines (VII.2): Postgres 18 with real migrations, Redpanda (transactions on), ElasticMQ (FIFO, dead-letter), Redis, Elasticsearch, DynamoDB local, Scylla and ClickHouse from `docker-compose.test.yaml`. Mocking the project's own repositories, ORM or stores is forbidden. Faults use the real TCP fault proxy (`test/fakes/tcp-fault-proxy.ts`: refuse, hang, delay, drop acknowledgements). The CDC spec needs the opt-in Debezium profile (gap G-14).
- Time and randomness: the fake clock for every lease, backoff, retention and timeout; a scripted random source for jitter; `waitFor` only, no fixed sleeps.
- Every e2e test asserts the response or return value **and** the persisted state: outbox rows, inbox rows, log contents (read back through a real consumer), read-model contents, checkpoints, dead-letter records, metrics or captured log lines (VII.2).
- Async consumers (VII.4): each fixture consumer has a duplicate-delivery test (AS-28 to AS-30) and an invalid-payload test (AS-50, AS-51, AS-96).
- Contract layer (VII.6): fixture routes and events parse with the fixture's `packages/contracts` schemas; the envelope parses with the shared envelope schema (AS-108).
- Unit specs sit beside the code, are table-driven (`it.each`), and exist only for pure logic (VII.5): event definition rules, topic policy, consumer declaration checks, `applyIfNewer`, coalescing, backoff and jitter bounds, error classification, read-your-writes wait logic, option validation, connector configuration, the static isolation scan. `fast-check` covers `applyIfNewer` (order-insensitivity: any permutation of versions converges to the maximum) and coalescing (result is the per-aggregate maximum).
- **UI journeys**: none. The capability has no screen; the user-visible effect (a saved product appears on the next page) is the happy path owned by W-capabilities and S05 and is not re-tested here. The F-05 admin page is a later web capability.
- Static gates (VII.1): `tsc --noEmit`, ESLint (no `Date.now`, `new Date()`, `Math.random` in this lib's `domain/`-style pure code), `pnpm check:boundaries` (infrastructure imports no domain), `pnpm check:table-ownership --strict` (AS-09).
- Every degradation path (broker down, store down, dead-letter unavailable, checkpoint store down, fallback, parking) has a forcing test (VII.9). A bug fix adds a test that fails without it.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 | `events/outbox-append.e2e-spec.ts`: commit, row and envelope fields | — | — |
| AS-02 | `events/outbox-append.e2e-spec.ts`: rollback leaves zero rows | — | — |
| AS-03 | `events/outbox-append.e2e-spec.ts`: no transaction rejected; standalone writes one row | — | — |
| AS-04 | `events/outbox-append.e2e-spec.ts`: invalid payload, nothing written | — | `events/event-definition.spec.ts` (it.each schema failure table, error names path not value) |
| AS-05 | `events/outbox-append.e2e-spec.ts`: three events one statement, relay order | — | — |
| AS-06 | `events/outbox-append.e2e-spec.ts`: `Promise.all` two conditional updates, one row | — | — |
| AS-07 | `events/outbox-append.e2e-spec.ts`: 256 KiB + 1 rejected | — | — |
| AS-08 | `events/outbox-append.e2e-spec.ts`: framework-free append, raw conforming insert, contract violation rejected by the database | — | — |
| AS-09 | — | — | `outbox/outbox-isolation.spec.ts` (static scan of `libs/domains` for `"Outbox"` / `"ProcessedWebhookEvent"` SQL, models, associations) |
| AS-10 | — | — | `events/event-definition.spec.ts` (it.each: type pattern, duplicate `(type, version)`, `aggregateVersion` bounds) |
| AS-11 | `events/outbox-append.e2e-spec.ts`: unregistered type rejected; registered goes to `<type>.events` | — | — |
| AS-12 | — | — | `events/topic-policy.spec.ts` (`latest-per-key` with a delta event) |
| AS-13 | `outbox/outbox-relay.e2e-spec.ts`: key, unwrapped value, headers, published mark | — | — |
| AS-14 | `outbox/outbox-relay.e2e-spec.ts`: broker refuses, attempts, jitter window, recovery | — | `outbox/backoff.spec.ts` (full-jitter bounds, `fast-check`) |
| AS-15 | `outbox/outbox-relay.e2e-spec.ts`: mark fails after send, two messages same `eventId` | — | — |
| AS-16 | `outbox/outbox-relay.e2e-spec.ts`: two relays, 100 rows, no duplicate | — | — |
| AS-17 | `outbox/outbox-relay.e2e-spec.ts`: A1 fails, A2 A3 held, B1 published, order on the log | — | — |
| AS-18 | `outbox/outbox-relay.e2e-spec.ts`: park at 10, metric, log without payload, no longer blocks, requeue | — | — |
| AS-19 | `outbox/outbox-relay.e2e-spec.ts`: non-retryable parks at once | — | `outbox/error-classification.spec.ts` (it.each broker error → retryable or not) |
| AS-20 | `outbox/outbox-relay.e2e-spec.ts`: lease at 29 s and 31 s (fake clock) | — | — |
| AS-21 | `outbox/outbox-cdc.e2e-spec.ts` (Debezium profile): same topic, key, value, headers; poller off | — | — |
| AS-22 | — | — | `outbox/connector-config.spec.ts` (parses `infra/debezium/outbox-connector.json`) |
| AS-23 | — | — | `outbox/relay-config.spec.ts` (it.each mode values; startup validation) |
| AS-24 | `outbox/outbox-retention.e2e-spec.ts`: published only, batches of 1,000, second run, job registered | — | — |
| AS-25 | `events/event-publisher.e2e-spec.ts`: validation, keying, hang → `PublishTimeoutError`, no database call | — | — |
| AS-26 | `events/event-publisher.e2e-spec.ts`: dropped acknowledgement, one copy on the topic | — | — |
| AS-27 | `events/trace-propagation.e2e-spec.ts`: same trace ID producer to consumer (in-memory exporter) | — | — |
| AS-28 | `projections/consumer-idempotency.e2e-spec.ts`: inbox consumer, delivered twice, one effect | — | — |
| AS-29 | `projections/consumer-idempotency.e2e-spec.ts`: version-guard consumer, same `eventId` and different `eventId` same version | — | — |
| AS-30 | `projections/consumer-idempotency.e2e-spec.ts`: natural consumer delivered twice | — | — |
| AS-31 | `projections/consumer-idempotency.e2e-spec.ts`: throw after effect, nothing persists, retry once | — | — |
| AS-32 | `projections/consumer-idempotency.e2e-spec.ts`: two instances, same `eventId`, `Promise.all` | — | — |
| AS-33 | `projections/consumer-idempotency.e2e-spec.ts`: 3, 1, 2 → version 3, `stale` counts | — | — |
| AS-34 | `projections/consumer-idempotency.e2e-spec.ts`: equal version is `duplicate` | — | — |
| AS-35 | `projections/consumer-idempotency.e2e-spec.ts`: no overlap per aggregate in 200 events | — | — |
| AS-36 | `projections/consumer-idempotency.e2e-spec.ts`: throw once, retry, offset passes after success | — | — |
| AS-37 | `projections/consumer-idempotency.e2e-spec.ts`: connection cut before and after the effect, committed offset, redelivery | — | — |
| AS-38 | `projections/consumer-idempotency.e2e-spec.ts`: second instance joins, one owner per partition, 1,000 events once | — | — |
| AS-39 | `projections/consumer-idempotency.e2e-spec.ts`: two groups, one slowed | — | — |
| AS-40 | `projections/consumer-idempotency.e2e-spec.ts`: 30 events → 1 call, counts | — | `projections/coalesce.spec.ts` (`fast-check`: result is the per-aggregate maximum) |
| AS-41 | — | — | `projections/consumer-declaration.spec.ts` (coalesce on a delta event type) |
| AS-42 | `projections/consumer-idempotency.e2e-spec.ts`: delete v5, late upsert v4, upsert v6 | — | — |
| AS-43 | — | — | `projections/consumer-declaration.spec.ts` (missing mechanism, duplicate group name) |
| AS-44 | `inbox/inbox.e2e-spec.ts`: claim new pair | — | — |
| AS-45 | `inbox/inbox.e2e-spec.ts`: two claims `Promise.all` | — | — |
| AS-46 | `inbox/inbox.e2e-spec.ts`: terminal statuses `DUPLICATE_DONE` | — | — |
| AS-47 | `inbox/inbox.e2e-spec.ts`: `FAILED` and stale `RECEIVED` re-claim (fake clock) | — | — |
| AS-48 | `inbox/inbox.e2e-spec.ts`: purge old terminal rows only, batches | — | — |
| AS-49 | `inbox/inbox.e2e-spec.ts`: `recordOnce` rollback and commit | — | — |
| AS-50 | `projections/consumer-failures.e2e-spec.ts`: three malformed shapes, batch continues | — | — |
| AS-51 | `projections/consumer-failures.e2e-spec.ts`: third of five invalid, reason holds paths not values | — | — |
| AS-52 | `projections/consumer-failures.e2e-spec.ts`: unknown type ignored, offset committed | — | — |
| AS-53 | `projections/consumer-failures.e2e-spec.ts`: newer version dead-lettered | — | — |
| AS-54 | `projections/consumer-failures.e2e-spec.ts`: v1 upgraded to v2 | — | `projections/upgrade-chain.spec.ts` (it.each upgrade paths) |
| AS-55 | `projections/consumer-failures.e2e-spec.ts`: non-UUID aggregate ID | — | — |
| AS-56 | `projections/consumer-failures.e2e-spec.ts`: dead-letter bytes and header set | — | — |
| AS-57 | `projections/consumer-failures.e2e-spec.ts`: 3 attempts then `HANDLER_FAILED`, partition continues | — | — |
| AS-58 | `projections/consumer-failures.e2e-spec.ts`: budget 6, six invocations | — | — |
| AS-59 | `projections/consumer-failures.e2e-spec.ts`: 30 s sink outage via fault proxy, zero dead letters | — | `projections/error-classification.spec.ts` (it.each error → transient or permanent) |
| AS-60 | `projections/consumer-failures.e2e-spec.ts`: `SinkBackpressureError` pause 2 s, other partitions flow | — | — |
| AS-61 | `projections/consumer-failures.e2e-spec.ts`: 5,000 events, never more than 500 in the handler | — | — |
| AS-62 | `projections/consumer-failures.e2e-spec.ts`: dead-letter topic unwritable, offset held, metric | — | — |
| AS-63 | `projections/consumer-failures.e2e-spec.ts`: redrive four, fourth redrive refused for a message at 3 | — | — |
| AS-64 | `projections/consumer-failures.e2e-spec.ts`: stop mid-batch, committed offset, 20 s | — | — |
| AS-65 | `projections/consumer-failures.e2e-spec.ts`: hung handler, 30 s timeout, no rebalance | — | — |
| AS-66 | `projections/versioned-sinks.e2e-spec.ts`: Redis, 200 racing pairs | — | — |
| AS-67 | `projections/versioned-sinks.e2e-spec.ts`: Elasticsearch 3, 2, 3 and a bulk of 100 | — | — |
| AS-68 | `projections/versioned-sinks.e2e-spec.ts`: DynamoDB conditional put | — | — |
| AS-69 | `projections/versioned-sinks.e2e-spec.ts`: Scylla version timestamp | — | — |
| AS-70 | `projections/versioned-sinks.e2e-spec.ts`: ClickHouse duplicate batch and stale version, read with `FINAL` | — | — |
| AS-71 | — | — | `projections/version-guard.spec.ts` (it.each pairs; `fast-check` permutation converges to maximum) |
| AS-72 | `projections/versioned-sinks.e2e-spec.ts`: fail on the 4th write, retry batch, same final state | — | — |
| AS-73 | `projections/read-your-writes.e2e-spec.ts`: caught up, no wait, header | — | — |
| AS-74 | `projections/read-your-writes.e2e-spec.ts`: catch-up at 200 ms | — | — |
| AS-75 | `projections/read-your-writes.e2e-spec.ts`: projector stopped, fallback to write model | — | — |
| AS-76 | `projections/read-your-writes.e2e-spec.ts`: `202` with `Retry-After` and body | — | — |
| AS-77 | `projections/read-your-writes.e2e-spec.ts`: `it.each` malformed `minVersion`, `400`, no wait | — | — |
| AS-78 | `projections/read-your-writes.e2e-spec.ts`: other tenant `404` identical to missing, checkpoint untouched | — | — |
| AS-79 | `projections/read-your-writes.e2e-spec.ts`: checkpoint store down (fault proxy) | — | — |
| AS-80 | `projections/read-your-writes.e2e-spec.ts`: 7, 5, 9 → 9, expiry after 24 h (fake clock) | — | — |
| AS-81 | — | — | `projections/read-your-writes-wait.spec.ts` (frozen clock: reached, timeout, unavailable, clamp, jitter bounds, replica probe) |
| AS-82 | `projections/replay-rebuild.e2e-spec.ts`: in-place replay, content hash equal | — | — |
| AS-83 | `projections/replay-rebuild.e2e-spec.ts`: live member, `GROUP_ACTIVE`, offsets unchanged | — | — |
| AS-84 | `projections/replay-rebuild.e2e-spec.ts`: shadow v2, promotion refused then allowed, atomic switch | — | — |
| AS-85 | `projections/replay-rebuild.e2e-spec.ts`: rollback to v1, v1 kept current | — | — |
| AS-86 | `projections/replay-rebuild.e2e-spec.ts`: stop at 400, resume, once in effect | — | — |
| AS-87 | `projections/replay-rebuild.e2e-spec.ts`: `NOT_REPLAYABLE`, override with audit line | — | — |
| AS-88 | `projections/replay-rebuild.e2e-spec.ts`: truncated history refused; compacted topic rebuilt | — | — |
| AS-89 | `projections/replay-rebuild.e2e-spec.ts`: lag 40 then 0, unknown group | — | — |
| AS-90 | `outbox/outbox-tasks.e2e-spec.ts`: task commit sends with row ID as dedupe ID; rollback sends nothing | — | — |
| AS-91 | `outbox/outbox-tasks.e2e-spec.ts`: body cleared after send, kept after failure | — | — |
| AS-92 | `sqs/task-queue.e2e-spec.ts`: 2 s delay delivered once | — | `sqs/enqueue-options.spec.ts` (it.each negative, fractional, 901, delay with group) |
| AS-93 | `sqs/task-queue.e2e-spec.ts`: FIFO dedupe, group order, failing group isolated | — | — |
| AS-94 | `sqs/task-queue.e2e-spec.ts`: concurrency 4, 15 s handlers, visibility extension | — | — |
| AS-95 | `sqs/task-queue.e2e-spec.ts`: `receiveCount` 2, 3, then dead-letter queue | — | — |
| AS-96 | `sqs/task-queue.e2e-spec.ts`: invalid body to dead-letter queue, handler not called | — | — |
| AS-97 | `sqs/task-queue.e2e-spec.ts`: duplicate delivery with `recordOnce`, one effect | — | — |
| AS-98 | `sqs/task-queue.e2e-spec.ts`: `stop()` waits for in-flight | — | — |
| AS-99 | `sqs/task-queue.e2e-spec.ts`: 25 in chunks of 10, one entry rejected, result lists it | — | — |
| AS-100 | `sqs/task-queue.e2e-spec.ts`: event delivered twice, one message per recipient | — | — |
| AS-101 | `sqs/task-queue.e2e-spec.ts`: same trace ID through attributes | — | — |
| AS-102 | `projections/kafka-transactions.e2e-spec.ts`: 10 in, 3 out, `read_committed` reader | — | — |
| AS-103 | `projections/kafka-transactions.e2e-spec.ts`: abort invisible, restart yields once | — | — |
| AS-104 | `projections/kafka-transactions.e2e-spec.ts`: two instances same identity, older fenced | — | — |
| AS-105 | `projections/observability.e2e-spec.ts`: scrape names, labels, no ID-like label values | — | — |
| AS-106 | `projections/observability.e2e-spec.ts`: captured log lines hold no payload value, token or address | — | — |
| AS-107 | `projections/contract-evolution.e2e-spec.ts`: extra field ignored, missing required field dead-lettered | — | — |
| AS-108 | — | — | `events/contracts-parity.spec.ts` (envelope and fixture payloads parse with `packages/contracts` schemas) |
