# Plan: make the full spec run fast (written 2026-10-20)

Goal: backend e2e, front-end unit and browser tests, all together, in about 20 minutes (target 17 to 25) instead of 60 to 90, without weakening a test.
Details and raw numbers: `docs/work/2026-10-20-whats-left-hanging.md`, sections 9 to 13.

## Measured facts (2026-10-20)

- Backend unit tests (470 files, 9,316 tests): 42 s. Fast. Front-end unit tests (303 files) already run on Vitest.
- Backend e2e: 591 files, 5,991 tests, serial (`--runInBand`), about 5.6 s per file on average; the full sweep is estimated at 40 minutes before
  the Scylla fix. First numbers on a real run: 10% (60 suites) at +6 minutes, 20% at +22 minutes (the `assistant` suites sit in that stretch).
- Time inside a suite (8 suites profiled): the tests themselves are small (0.2 to 3 s for most); the rest is the per-file load (1.1 to 2.9 s; 6 s for
  `bff`) and the reset before each test.
- The Scylla reset truncated all 41 tables one after another on every `beforeEach` (9.8 s). Fixed in the working tree: only tables that hold rows,
  in parallel (`assistant-limits` 253 s to 20 s, `assistant` 269 s to 77 s).
- The Postgres reset truncates all 233 tables with `CASCADE` (about 130 ms per test, 363 of 591 files). The FK graph is shallow (64 FKs;
  `User` cascades to 15 tables), so a dirty-tables-only reset is safe; a one-query check for rows costs about 35 ms.
- Jest compile: cold 2.98 s versus warm 1.15 s per file; swc halves the cold compile and changes nothing warm. Evaluation of the imports (1.1 s
  per file) is Jest's module isolation, not compilation.
- Fixed sleeps: 141 s in 119 files if each ran once; the big ones are `consumer-failures` (32 s), `task-queue` (29 s), `statement-export` (10 s).
- Browser tests (Playwright, 2 workers): about 22 to 25 minutes for about 460 tests, about 6 s per test; the clock specs add 1.5 minutes. The
  test Postgres already runs with `fsync=off` on tmpfs.
- A full test stack starts in 2 min 20 s on the laptop (Scylla needs `fs.aio-max-nr` raised to run next to the dev stack); the first migration
  attempt can fire before Scylla answers.

## Work packages, in order, with the check for each

1. Timing reporters (backend e2e, Playwright): per suite and per test, with load, `beforeAll`, resets, tests, written to a file on every sweep and
   gate. Check: a report with the slowest 20 suites after one sweep. The throwaway version is `/tmp/prof/hook-timer.js` (not in the repo).
2. Postgres reset: truncate only tables that hold rows (one query to find them). Check: the same suites pass; measure the saving first.
   Known caveat: sequences of skipped tables are not restarted.
3. The slowest suites, with the reporter's data: real test work (`assistant` 63 s, `asset-upload` 18 s, `webhooks-wiring` 8 s), the fixed sleeps,
   the 20% of places that hold 80% of the time.
4. Front end: log in through the API with a saved session (`storageState`) instead of the UI (`register(page)`: 78 call sites, estimated 10 to 15
   minutes of worker time, NOT measured); serve a production bundle for the whole suite, built once and cached by a hash of the web and contracts
   sources.
5. Shards, backend and front end together: `jest --shard=i/N` and `playwright --shard=i/N`. A browser shard is a whole backend slice. Isolation
   layer: Postgres database cloned from a template, Redis DB, Scylla keyspace, Dynamo prefix, and per-shard names for Kafka topics, queues,
   Elasticsearch indexes, ClickHouse tables, media bucket. UNKNOWN: which of those names are hard-coded; do the inventory first. Memory: about
   5 GB per backend stack, about 8 GB per browser slice; 32 GB fits 2 to 3 shards, 64 GB about 5. Lighter variant: share Kafka, Elasticsearch and
   ClickHouse.
6. Vitest spike (rule in section 13 of the notes file): go if the projected saving is at least 10 minutes and all three test orders pass.
7. Fresh runners: bake the Jest cache, `.next/cache` and the Playwright browsers into the runner image; skip the web build and browser batches by
   fingerprint when nothing changed; `jest --findRelatedTests` (15 to 35% of the e2e suites for a domain change, 82% for shared infrastructure).

## Expected result (an estimate to be checked after packages 1 to 3)

After the Scylla and Postgres fixes the backend sweep is about 27 minutes; over 3 shards about 9. The browser suite is 25 minutes now; with the
production bundle and API login perhaps 12 to 15, over 2 shards 6 to 8. One after the other about 21 minutes; at the same time about 12 on a 64 GB
machine. Add 2.5 minutes of stack start-up.

## What can go to an unattended VM run, and what cannot

- Fit for the loop (clear check, little judgment): packages 1, 2, 4, 7 (the reporter, the Postgres reset, API login, the bundle cache, the image).
  Guardrails: no test may be loosened or skipped (the integrity check `scripts/sdd/check-tests.py integrity` applies), each change measured
  before and after, a work order that is not a product capability, so the harness needs a work type for it first.
- Interactive, with the owner: package 3 (needs the reporter's data), package 5 (unknown names), package 6 (go or no-go from numbers).

## Open items found on the way

- Scylla cleaner change is uncommitted (`packages/backend/libs/infrastructure/cassandra/cassandra.module.ts`); run the A/B on
  `community/discussions` and `community/discussions-votes` with the original cleaner before committing.
- `assistant-metering` (S46 AS-69): the ClickHouse table `llm_requests` is missing from the local test stack. `sync-feed-consumer` (S09 AS-26):
  a plan limit from a later capability breaks the older test.

## Addendum: exploration by the QA agent at scale (owner question, 2026-10-20 late)

Idea from the owner: the QA agent explores every capability, finds gaps, extends the tests and fixes the bugs it finds; this is not an SDD loop but
something different (design question for the next session). Can the exploration of the whole app take about 20 minutes without losing quality?

What the agent is today (`scripts/qa/run.sh`, `scripts/qa/prompt.md`): a fresh `claude -p` session per charter that writes short Node scripts using
Playwright as a library (headless Chromium), plus API, read-only database, queue and log checks as oracles; default time box 15 minutes
(`minutes:` in the charter), budget `QA_BUDGET_MIN` 30 per checkpoint. Used only on 2026-10-13 (buy twice, discover once); 5 of 7 charters never ran.

Where the time goes: not measured. Hypothesis: the model's loop (plan, write a script, read output), not Playwright. Measure first: the share of
model time versus browser time in one charter run.

Ways to the target, in order of leverage:
1. Many agents in parallel, one per charter group (about 10 to 12), each on its own isolated backend slice: the same isolation layer as the test
   shards. Wall time is about the longest time box. Limits: the model usage limit, and memory (about 5 to 8 GB per slice).
2. A cheaper lane through HTTP only for logic charters (no browser, no screenshots); the browser lane for layout and interaction.
3. Schema-driven API fuzzing from the OpenAPI document: no model, minutes for the whole API, finds 5xx and validation errors.
4. Preloaded fixtures and logged-in sessions, so agents spend no time on setup.
5. Cheaper model for breadth, stronger one for verification.
Quality: a time box per charter caps depth; parallelism adds breadth. Not an executor swap.

## Fix-later list (found 2026-10-21, deliberately not worked on before the speed-up)

- `catalog-sync/import-fairness` (S07 AS-63, 1 of 6 tests): fails every time with the dirty-tables-only Postgres reset (commit 40aa225f), passes with the old reset.
  The failure is a 503 `rate_limiter_unavailable` ("Stream isn't writeable") from Redis. Look at what the reset leaves behind or skips.
- Failing with both resets (12 tests in 6 suites): `developer-platform-*` (4 suites), `catalog-sync/sync-fields`, `assistant/knowledge-events`.
- Other failures in the partial sweep: `orders-boundary` (voucher.service.ts imports infra), `product-shop-lifecycle` (Product.shopId nullable), `assistant-metering`,
  `sync-feed-consumer`, `discussions*` (S25 AS-19/24/29), `trending-stream` (344 s, 3 tests).

## Findings 2026-10-21 (speed work)

- Production bundle for the whole browser suite is blocked: `NODE_ENV !== 'production'` gates the sandbox card picker (`components/checkout/payment-fields.tsx:29`),
  by design; the checkout journeys need it. The dev server compiles each route once per run, so the cost is likely small; measure with the Playwright
  timing reporter (`TEST_TIMING_OUT`) before choosing a fix.
- Browser login through the API: `register(page)` now calls `registerByApi` (register + login through `page.request`, same calls as the forms); `auth.spec.ts`
  keeps the UI path (`registerThroughUi`); `PW_UI_LOGIN=1` restores the UI path everywhere. NOT yet run.
- Vitest spike works on the e2e suites: `packages/backend/vitest.e2e.config.ts` (unplugin-swc for decorator metadata, `isolate: false`, one fork, `jest` shim for
  `jest.spyOn/fn/restoreAllMocks`), `bff` needed `resolve.dedupe: ['graphql']` + inlining graphql/apollo (two copies of graphql otherwise).
- Shards: `scripts/infra/shard-stack.sh <n> <env|up|setup|down>` generates a whole separate test stack per shard (ports shifted by 10 per shard). Not yet started.

## Vitest spike result (2026-10-21, 30 suites = every 20th e2e suite, excluding the 5 slowest)

- Jest, batches of 12 fresh processes: 367 s. Vitest, one process, `isolate: false`: 315 s (order A) and 313 s (reverse). Saving 52 s per 30 files = 1.7 s per file,
  so about 17 minutes over 593 files (rule: go if at least 10 minutes and all orders pass).
- Same failures as Jest (`import-fairness`, the new-reset one) in order A. Reverse order has one more: `order-export-lifecycle` line 492 (it reads captured log lines;
  passes alone and in order A). Order-dependent state with `isolate: false`: find it before switching (the Nest logger override is the first suspect).
- Verdict: GO, with that one order dependence to remove. Not switched yet: Jest stays the runner until the full Vitest sweep matches Jest's results.
- trending-stream: helper G2 shared one app between six tests, but a test in between closes the app (Sequelize 'connection manager was closed'): reverted. Redo with the close moved.

## State at 14:25 on 2026-10-21 (before a laptop reboot)

- Full backend e2e suite on 5 shards (scripts/speedup/run-sharded.sh 5): 812 s of running + 45 s of preparing = 14.3 min, 8,390 tests passed, 4 failed
  (trending-platform, launch-events-operations, load-shedding, launch-events-queue (20 runs)): all four read logs or metrics and pass alone.
  Earlier: 1,113 s (split by file count), 992 s (split by measured time). Baseline before today: about 95 min.
- Per-shard file times are even after the balanced split; what remains is the first-time loading of big code sets (about 30 to 45 s per shard,
  220 s in the unlucky shard), a single-core Scylla/Kafka shared by all shards, and a few long real-time files (trending-stream 131 s, ads-aggregation 95 s,
  consumer-failures 89 s, search-reindex 72 s).
- Next: fix the 4 failures; try 8 shards (plan: 9 min); optional: convert the sources once with swc and share them between shards.
- After a reboot: scripts/infra/stack.sh test setup, then scripts/infra/shard-prepare.sh for each shard is done by run-sharded.sh itself; shard Redis
  containers (marketplace_test_redis_s<n>) are recreated by shard-prepare.sh; the template database is re-created on first prepare.
- Cleanup of disk: docker system prune / docker volume prune (unused only); the swap can be reset with: sudo swapoff -a && sudo swapon -a
