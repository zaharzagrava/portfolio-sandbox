# Speed-up build plan (2026-10-21)

Goal: the whole backend e2e suite in about 10 minutes of waiting on one machine (more with several machines), without losing a single check.
Rules for every helper: see "Rules for editing a test file" below. Plain words everywhere (owner's rule).

## Work streams
1. Optimize the test files (8 helpers, about 75 files each, folders listed below). Helpers READ and EDIT only; they never run tests (all suites share one set of
   databases and wipe them, so two runs at once break each other). A finished file goes onto `specs/.checkpoints/speedup-ready.txt`; the owner's assistant checks it
   with `scripts/speedup/check-ready.sh` (one file at a time, about 10 to 60 seconds each) and failures go to `speedup-failed.txt` for a fix round.
2. Switch the runner from Jest to Vitest everywhere (scripts, package.json, CI, the loop's gates), plus "rerun only what changed" (a script that picks the
   test files related to the changed source files, and remembers files that already passed for the same content).
3. Sharding with shared services ("light" sharding): one set of Postgres, Redis, Kafka, Elasticsearch, ClickHouse, Scylla, Dynamo, MinIO and queues; each
   shard gets its own names (database, Redis number, keyspace, table prefix, topic names, queue names, search index names, bucket). About 1 GB per shard.

## Folder groups for stream 1 (paths under packages/backend)
- G1: libs/domains/identity, tenancy, seller-onboarding, shop-functions
- G2: libs/domains/catalog-sync, catalog, discovery
- G3: libs/domains/developer-platform, orders, auctions, launch-events
- G4: libs/domains/payments, billing, statements, fulfilment, marketing
- G5: libs/domains/media, asset-library, community, assistant, content, chat
- G6: libs/domains/seller-insights, experimentation, notifications; apps/projector; libs/composition
- G7: apps/core, apps/worker, apps/sse-gateway, apps/local-monolith, apps/lambdas; libs/infrastructure/rate-limit, realtime, cache, jobs
- G8: the rest of libs/infrastructure (serverless, projections, outbox, events, platform, llm, context, sqs, net, lifecycle, inbox, idempotency, http)

## Rules for editing a test file (no check may get weaker)
- Keep every scenario id (S.. AS-..), every assertion, every expected value. Do not delete or skip a test, do not loosen a number, do not widen a time limit to hide a slow step.
- What you MAY change to save time:
  a. A wait that repeats inside one test (a loop, or a handler that waits N seconds for each of M messages): shrink the repeats or the wait while the test still proves the same thing.
     Example done: the queue test sent 20 messages with a 15 s handler, 4 at a time (75 s); now 12 messages, 4 s handler, 2 s claim window (12 s), same two checks.
  b. A fixed `sleep(n)` waiting for something to happen: replace by waiting until it happens (poll every 50 to 100 ms, same overall limit). Keep a fixed wait only
     when the test proves that NOTHING happens for a time ("stays empty for 1.5 s"): then shorten only if the real rule behind it is shorter than the wait.
  c. Tests that only use their own data (own queue name, own shop and user, no global wipe needed): mark the group `describe.concurrent` so waits overlap. Only when no
     test in the group relies on the global wipe in `beforeEach` (`seeds.clean()`), a shared variable, or the order of tests.
  d. Setup repeated in every test (`beforeEach`) that could happen once (`beforeAll`) without tests seeing each other's data.
  e. Needless work: reading the whole table when one row is needed, creating 100 rows where 5 prove the point, repeated app start-ups.
- The runner is Vitest from now on (the `jest` global still works through a small shim in `test/vitest-jest-shim.ts`). Vitest-only features are allowed.
- Do NOT change anything outside your folders. Do NOT run tests, start servers or touch docker. Do not commit.
- For each file you finish: append its path (relative to packages/backend) to `specs/.checkpoints/speedup-ready.txt`, and add a note to `docs/work/speedup-notes/<group>.md`:
  file, what changed, expected saving in seconds with the reason, and what could break. Files you looked at and could not improve: list them too with the reason (one line).
- Work file by file in order of expected saving (search for loops of waits, `sleep(`, `setTimeout`, big time limits `}, 60_000)`, `for (` with awaits, many `it(` that each boot an app).
