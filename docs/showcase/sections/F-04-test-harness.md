# F-04 — Test Harness (e2e against real docker-compose DBs)

Status: ☑ done (specs written + typechecked, not run) · Phase 0 · Depends on: F-02 · Used by: all sections (D5)

## Approach (user's preferred style, D5)
Endpoint-level e2e specs that build a Nest testing module from the **real feature modules**, call endpoints with supertest through the full pipeline (ValidationPipe, global prefix, `AllExceptionsFilter`), and run against **real local databases from `docker-compose.test.yaml`**. Assert the response **and** the resulting state in Postgres / Redis / Scylla / DynamoDB / ES / ClickHouse / Kafka topic. Only critical flows. Written + typechecked, not run (for now).

## Existing code to extend
- `libs/common/src/utils/test-utils/global-modules.ts` — `generateTestingModule()`.
- `libs/common/src/seeds/seeds.service.ts` — `clean()`, `createTreelike()` (nested `__type__` fixtures with `GET_FROM_PARENT`).
- `libs/common/src/utils/test-utils/test-utils.service.ts` — `checkReqError()`, `checkMethodErr()`.
- `firebase.service.mock.ts`, `api-config.service.mock.ts`.
- `docker-compose.test.yaml` (stale: old project name, Postgres 17, port 5300 collides with dev DB).

## Patterns showcased (lesson 08/04)
- Integration-heavy "testing trophy": real DB queries, real constraints, real Lua scripts, real Kafka — the bugs that matter at scale (races, constraint violations, isolation anomalies) only show up against real engines.
- Concurrency e2e: fire N parallel requests (`Promise.all`) at a contended resource (seat, auction, stock) and assert exactly-one-winner invariants.
- Deterministic time: `MockDate` + injectable `Clock` for TTL/expiry logic.
- Contract snapshot: OpenAPI document snapshot test (README #12).

## Steps
- [x] Rewrite `docker-compose.test.yaml` (`-p marketplace_test`): postgres(+postgis+pgvector, port 5400), redis (6400), redpanda (9192), elasticsearch (9300), clickhouse (8223), scylla (9142), dynamodb-local (8100), minio (9100), elasticmq (9424). tmpfs volumes for speed.
- [x] `.env.test` / `MockApiConfigService` defaults pointing at those ports.
- [x] `generateTestingModule`: optional extra global modules (Redis, Kafka, Scylla, Dynamo, S3, SQS) via an options arg; keep the current signature working.
- [x] `SeedsService.clean()` → also flush test Redis DB, truncate Scylla tables, delete Dynamo items, purge SQS queues, delete ES test indices (each store's cleaner registered by its module).
- [x] `createTreelike` — add `TableName` entries for every new model as sections land.
- [x] `TestUtilsService.login(email|userId, role)` helper for the JWT auth used in this repo (mirrors `customLogin`).
- [x] Helpers: `waitFor(predicate, timeout)` for async projections (Kafka → read model), `parallel(n, fn)` for contention tests, `consumeTopic(topic, untilCount)`.
- [x] Root `package.json` scripts: `test:e2e:infra-up` (`docker compose -f docker-compose.test.yaml -p marketplace_test up -d`) — documented, never run by Claude.
- [x] `jest-e2e.json`: `moduleNameMapper` for `@app/common`, `testTimeout: 60000`, `maxWorkers: 1` (shared DB).

## Scale
Contention specs are the functional half of the scale proof (exactly-once under parallel load); k6 is the throughput half.

## Implementation notes (2026-10-01)
- `docker-compose.test.yaml` rewritten (`-p marketplace_test`): postgres(+postgis/pgvector, tmpfs, fsync off) 5400, redis 6400, redpanda 9192, ES 9300, ClickHouse 8223, Scylla 9142, DynamoDB 8101, MinIO 9200, ElasticMQ 9424.
- `env/test.env.example` → copy to `.env.test` (root `.gitignore` ignores `.env.*`, so templates live in `packages/backend/env/`). `configs/db.config.js` `test` env aligned (5400, marketplace_test).
- `jest-e2e.json` at backend root (roots apps+libs, `*.e2e-spec.ts`, `@app/common` mapper, 60 s timeout) + `test/e2e-env.setup.ts`; scripts `test:e2e` (`--runInBand`) and `test:e2e:infra-up`.
- `generateTestingModule(modules, { stores })` now always adds RequestContext/Transaction/Health/TestCleanup modules and optional `redis|cassandra|dynamo|sqs|storage`.
- `TestCleanupRegistry` (stores register wipe functions; `SeedsService.clean()` runs them) + `clean()` now also wipes Outbox and Product.
- Seeds: `Product` added to `createTreelike` schema with defaults; generic `CreateTreelikeFixture<Model, TableName>` for new tables.
- Helpers: `waitFor`, `inParallel` (gate-released concurrency), `countStatuses`, `expectProblem`; `AuthService.issueTokensFor(user)` for logging in in specs.
- New shared `RedisModule` (auto-pipelining, offline queue off → callers choose fail-open/closed).
- Specs for existing flows (Q9): `payment/payment.e2e-spec.ts` (duplicate delivery → one payment/ledger set/event; redelivery doesn't recharge; last-unit race → one sale + ≤1 refund; out-of-stock → no charge), `outbox/outbox-publisher.e2e-spec.ts` (publish + mark, broker down keeps rows, recovery publishes once), `apps/core/test/app.e2e-spec.ts` (health).
- Removed stale `apps/*/test/app.e2e-spec.ts` (imported non-existent modules) and per-app `jest-e2e.json` → replaced by the root config.
