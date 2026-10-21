# Shared test code: findings and changes (2026-10-21)

Nothing here was run against the databases (no e2e, no docker). Checked: `npx tsc --noEmit` (the only error is in `libs/infrastructure/sqs/task-queue.e2e-spec.ts`, a spec another helper is editing: `describe.concurrent` is not known to the old Jest typings) and the unit tests of the dynamo/cassandra folders (4 pass).

## 1. How test files build their app

593 e2e files in total. There is no single "test app". Four kinds exist:

1. **Feature app builders** (about 45 `createXxxApp` functions in `libs/domains/*/testing`, `test/utils`, `libs/infrastructure/*/testing`). Almost all of them call `generateTestingModule` (`test/utils/global-modules.ts`) and about 32 spec files call it directly. Most used: catalog app 38 files, auth 27, tenancy 20, billing 16, realtime 13, payments 12, delivery 12, orders 11, and so on (6 to 10 files each for the rest). Many of them are built on top of the catalog app (search, import, discussions, feeds...), so they pay the catalog start-up plus their own.
   What one start-up does:
   - loads every domain's entry file (so all Sequelize models exist), the rate-limit tables of 13 domains, tenancy, config, request context, health;
   - opens the Postgres connection (Sequelize, models auto-loaded), then Redis (always), plus the stores the feature asks for (Scylla/Cassandra, DynamoDB, SQS, storage, Elasticsearch);
   - Scylla connect happens in the module start-up step and Nest runs these steps module after module, so it waits behind others; ClickHouse (only in modules that import it) does a ping in its own start-up step;
   - the outbox poller starts when the app boots (every 2 s, one per process), the jobs worker loops only when asked;
   - no migrations and no index creation happen in the app start-up; the search app creates/recreates its index in `resetSearch()` (per test) and when its module boots (`IndexBootstrapService`);
   - Kafka topics are created by the spec fixtures (`createTopics`: opens an admin connection, creates, closes, for each call).
2. **Real application modules** (59 files use `NestFactory` or boot `CoreModule`/`WorkerModule`/etc. in `apps/*` wiring specs). They pay the full production start-up of that app.
3. **Toolkit app** (`test/toolkit/test-app.ts`, 6 files): a tiny app (config, clock, health, test controller). Cheap, nothing to gain.
4. **Child processes** (`test/toolkit/child-app.ts`, `start-child.ts`): a second copy of the app in another process for multi-instance tests. Expensive by nature.

## 2. The wipe before each test (`SeedsService.clean()`)

Three steps, in this order before my change:
1. Postgres: one query lists all tables with rows (about 35 ms, already "only truncate dirty tables"), then one TRUNCATE of those. Already well optimised.
2. The registered cleaners, one after another (`TestCleanupRegistry.runAll`). Only three exist:
   - **Redis**: `FLUSHDB`. One command, cheap, done even if the test never used Redis. (An "is it empty" check costs the same as the flush, so nothing to gain.)
   - **Scylla**: lists the tables (one query), probes every table with `LIMIT 1` in parallel, truncates only the tables that hold rows, in parallel. Already "dirty-only" (done earlier by the owner).
   - **Dynamo**: before: one ListTables, then for EACH of about 10 tables, one after another: DescribeTable, Scan, and batch deletes. About 21+ round trips in a row on every test, whether the test touched Dynamo or not.
   Queues (SQS), Kafka and Elasticsearch have NO global cleaner: each fixture cleans its own topics/queues/index (search `resetSearch`, `deleteTopicsMatching`). Nothing to skip there.
3. Per-feature `reset()` helpers (`createCatalogApp().reset()` etc.) are thin: `seeds.clean()` + clock + key cache. The heavy one is `resetSearch()` (deletes every products index, rewrites two synonym rows, deletes the synonym set in the engine, recreates an empty live index: about 6 sequential round trips). That one is needed for every search test; see the "risky" list.

## 3. Changes made (all in shared code, none in spec files)

| # | File | What | Expected saving | Risk |
|---|------|------|-----------------|------|
| 1 | `test/utils/test-cleanup.registry.ts` | Cleaners with the same priority now run at the same time instead of one after another (Redis, Scylla, Dynamo are separate stores). If one fails the others still finish, then the first error is thrown. | Wipe = slowest store instead of the sum: roughly 20 to 100 ms per test (about 360 files reset before each test, several tests each) | Low. Only breaks if two cleaners share a store; the three that exist do not. Error behaviour: an error still fails `clean()`, but the other stores are now also wiped (before they were skipped). |
| 2 | `test/seeds/seeds.service.ts` | The Postgres wipe and the other stores' wipe run at the same time (split into `cleanPostgres()`). Both finish before `clean()` returns; errors are rethrown (Postgres first). | About 35 to 150 ms per test (the Postgres part now overlaps the others) | Low to medium. If a background poller writes to Redis/Dynamo as a result of Postgres rows, the order was already a race; nothing relied on Postgres being empty before Redis is flushed. |
| 3 | `libs/infrastructure/dynamo/dynamo.module.ts` | Test-only cleaner: DescribeTable answers (key names) are remembered per table per process, and all tables are emptied at the same time. | Dynamo wipe from about 20 sequential calls to 1 list call + one parallel round: tens of ms per test, more on slower disks | Low. Key names of a table do not change within a process (a spec that deletes and recreates a table with the same name and a different key would break; none does: only `scripts/dynamo/create-tables.ts` and `versioned-sinks.e2e-spec.ts` create tables). Runs only in test modules (the cleaner is not registered in production). |
| 4 | `libs/infrastructure/cassandra/cassandra.service.ts` | The Scylla connection starts in the constructor and `onModuleInit` waits for the same attempt. Same error handling (logged, app still starts). | Overlaps the connect with the rest of start-up (other modules' creation, ClickHouse ping): 50 to 300 ms per app that uses Scylla | Low to medium. Production code path too: connection now starts a little earlier; the same log line on failure. A unit test that builds the service by hand would now try to connect immediately (none found: nobody does `new CassandraService`). If Nest fails to compile the app after creating the service, the client stays open (only matters for a broken spec). |
| 5 | `libs/domains/discovery/testing/search-app.ts` | The three optional fault proxies (search engine, Redis, Kafka) start at the same time. | Few ms, only for the specs that ask for proxies | Very low. |

## 4. Worth doing, but too risky without running tests (ranked by value over risk)

1. **Boot one app per file (or per describe) instead of one per `it`/`beforeEach`.** Biggest lever overall (an app start is about 1 to 3 s), but it belongs in spec files, which are other helpers' job; the shared builders already support it (`reset()` between tests). Risk: tests leaking state.
2. **Run the Postgres "which tables have rows" probe less often.** It is about 35 ms on 233 tables. Idea: have the app's models report writes (or use `pg_stat_user_tables.n_tup_ins` counters, which can lag) to skip the probe for read-only tests. Risk: stale counters or writes by raw SQL leave data behind, which breaks the next test silently. Needs a full-suite run to prove.
3. **`resetSearch()` in `search-app.ts`**: run the two Postgres synonym statements in parallel with the engine index delete (they do not depend on each other; only the synonym-set delete in the engine must follow the index delete). Saves maybe 10 to 30 ms per search test (about 10 files). Risk: low, but I could not prove the ordering without running; also could skip delete + recreate when the test did not change the index (needs a "dirty" flag set by the projector). 
4. **Cache the Scylla table list per keyspace** in the cleaner (one query saved, about 2 to 5 ms). Risk: a spec that creates a table mid-run would not be wiped.
5. **`createTopics` in `test/utils/kafka-test.ts`**: opens and closes a fresh admin connection each call (about 50 to 150 ms). Keep one admin connection per process and reuse it; also create several topics in one call where fixtures call it twice. Risk: stale connection after a broker fault-proxy test, needs a reconnect fallback; test with the Kafka suites.
6. **Share the Postgres connection pool/models across apps in one process** (build the Sequelize model set once). Sequelize `autoLoadModels` re-registers all models per app. Potentially hundreds of ms per boot, but it touches how Nest wires the database module; high risk of cross-app leaks with `isolate: false`.
7. **Create Elasticsearch index/synonym set once per process** and only clear documents between tests. Big for the search suites, but those specs test index lifecycle (reindex, alias swap), so they need the fresh index: only possible for a subset, decided file by file.
8. **ClickHouse ping at start-up** could also start in the constructor like Scylla now does (same pattern, small saving, only modules that import it).
9. **Postgres `ANALYZE`-free TRUNCATE of `RESTART IDENTITY`** costs more than plain TRUNCATE; sequences only matter to tests that read numeric ids. Dropping `RESTART IDENTITY` would be faster but could change expected ids. Needs the whole suite.

## 5. Things looked at and left alone
- Scylla cleaner: already dirty-only and parallel.
- Redis flush: cheapest possible.
- Toolkit app, `jobs-test-app`: small; the one `generateTestingModule` call dominates.
- The Postgres cleaner already retries deadlocks; untouched.
