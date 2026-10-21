# What is left hanging (2026-10-20)

Written after the build loop finished its last capability run. 66 of 67 capabilities are built; J05's gate is open and the final checkpoint was
running on the VM when this was written. The longer, older list is `docs/work/2026-10-16-after-the-build.md`; this page is the one to read first.

## 1. Not finished

- J05 (engagement loop): all tasks implemented, journey gate at 35 of 36 tests. AS-01 waits 20 s for a `feed.item_published` event on `feed.events`
  and times out. Probable cause: every event-tap read (`GET /api/admin/topics/:topic/messages`) creates a new Kafka consumer group, about 5 s per read
  (`libs/infrastructure/kafka/topic-tap.service.ts`). The relay schedule was lowered from 5 s to 2 s by a repair; that is not the remedy. No
  `.implemented` marker exists for J05.
- The final checkpoint (`!STOP final` at the end of `scripts/sdd/orders/by-flow.txt`): regression sweep of all backend suites and the browser suite, the
  scripted buy flow, the QA agent, checkpoint repair. It started on the VM on 2026-10-20 and its result is not in this page.

## 2. Known real defects

- Table ownership: `pnpm --dir packages/backend check:table-ownership --strict` reports 17 cross-domain table accesses (asset-library, catalog-sync,
  community, content, launch-events, orders (`order-export.service.ts` reads `Product`), seller-insights, seller-onboarding).
- `apps/payment-processor` does not boot on its own (AuditService needs RequestContext, then ShopGuard needs ShopAccessService). See "Found by
  boot-app.sh" in `README_ME.md`.
- `JournalInvalid` in the charge worker's ledger posting during the first scripted buy flow (the payment stays PENDING). Check that it is gone.
- `docs:check` fails (about 190 generated pages differ) and `pnpm slo:generate` has a module-resolution failure. Both pre-date the runs.
- The API log prints `MaxListenersExceededWarning: 11 finish listeners added to [ServerResponse]` about 9,000 times per full browser run: some
  middleware adds a finish listener per request.

## 3. Weakened or fragile tests

- W04 AS-19 was loosened by the doctor: `packages/web/tests/seller-live.spec.ts` waits up to 20 s for the Orders counter (spec: 2 s). The living page
  `docs/spec/capabilities/W04-*.md` (B-07) still says "within 2 seconds" and cites this test as its proof. Either restore 2 s or change the page.
- Log-check journeys (J01 AS-30, J03 AS-39) read the API log by byte offset and require every JSON line to carry a request id. KafkaJS logs through its
  own logger (partitioner warning, rebalance lines) with no id. J03 now takes a mark at its start (J01 already did), but a rebalance line inside a run still carries no id. Decide: route
  kafkajs through the app logger, or skip `logger: kafkajs` lines explicitly in the check.
- Flaky browser tests are recorded per capability in `specs/<capability>/flaky-specs.md` (the gate retries a failing browser test once).
- J02 AS-27 (a webhook receiver that fails then recovers must get the event once) timed out waiting 20 s for the event; never diagnosed.

## 4. Unverified claims

- `specs/deferred-checks.md`: 27 runtime proofs that were deferred to the final checkpoint (fresh-stack runs, standalone boots, full browser suites).
- `specs/UNVERIFIED.md`: 313 lines of things marked "not run".
- The shopping assistant (S46, W05) was only ever run with the scripted provider (`LLM_PROVIDER=scripted`): it answers `echo: <question>`. The
  Anthropic adapter (`AnthropicLlmProvider`) exists but has not run against a real model. Quotas, fallback model, tools and moderation are not exercised
  with real answers.

## 5. How far to trust docs/spec

- 66 capability pages (all but J05), 16 concept pages, 5 model pages, 1,747 term pages. `python3 scripts/livespec/check.py`: 0 errors, 1,959 warnings.
- All 66 capability pages have `status: draft`: none was read and signed by a human (`docs/spec/REVIEW.md` says how; start with S13, S10, S01).
- The scripts prove that links, terms and proof pointers exist (2,877 rules cite a test, 44 are marked `[proof: none]`). They do not prove that a
  cited test checks the sentence, nor that the test passes. The W04 AS-19 case above is an example of a page and its proof drifting apart.
- 183 "used by" blocks are stale (`check.py --fix-backlinks`), 173 terms have a rule or definition that changed since they were written.
- Treat the pages as the best map of what was built and why; check a number or a limit in the code before relying on it.

## 6. Decisions and housekeeping

- 60 files in `docs/work/decisions/`: read the BREAKING and CONTRACT lines first. `python3 scripts/decisions/triage.py status` shows what is open.
- The 15 term pages that judge granularity (`upstream`, `idempotency-key`, `event-consumer`, `inbox-table`, `loader`, `outbox-relay`,
  `published-version`, `search-facets`, `can-advance`, `decode-snapshot`, `replay-false`, `category-tracking`, `host-bff-cookies`,
  `combined-business-multiplier`, `rate-limit-policy`).
- Delete the merged remote branches `origin/harness/overnight` and `origin/claude/specs-incremental` (waiting for your OK).
- Rebuild the runner image with Chromium and ffmpeg and a clean database: `scripts/vps/build-snapshot.sh --with-web` (needs no runner alive). The
  image's database holds rows dated 2026-10-19/20 from journeys that moved the clock.
- Your `interview-prep/` edits are untouched and uncommitted.

## 7. Quick manual check on your machine (each in its own terminal; nothing detached)

- Once: `pnpm install`, `FORCE=1 bash scripts/infra/make-dev-env.sh` (rewrites `packages/backend/.env`).
- `moon run infra-setup`, then `moon run dev-monolith` (API :8000), then once `pnpm --filter api seed:dev`.
- `pnpm --filter api run start:lambda-local document-extractor media-processing` (shop verification, photos).
- `moon run dev-web` (http://localhost:3000). Logins: `admin@marketplace.local` and `seller@marketplace.local`, password `Demo-Seed-Pw-7491!`.
- Stop: Ctrl+C in each terminal, then `moon run infra-down`.

## 8. Found by hand (2026-10-20, manual check on the laptop)

- Seller product photos (`/dashboard/seller/<shopId>/products/<productId>/media`): after an upload the photo is "not properly loaded", disappears on reload,
  and "Save photos" does nothing. The browser test `seller-photos.spec.ts` passed on the VM, so this is a gap between the scripted test and a real
  session (the media stand-in was not running at first, see L-034; with it running the symptoms above remained). No charter of the QA agent covers
  seller product media, which is exactly what an exploratory pass is for. Not diagnosed.

## 9. Test speed plan (2026-10-20): the full suite must stop taking hours

Order agreed with the owner: (1) profile 3-10 backend e2e suites, (2) explore parallel execution, (3) let the running checkpoint finish, (4) the same for the
browser tests, (5) then rewrite the QA charters and rerun the QA agent.

Measured so far (VM checkpoint, 2026-10-20, config fixed): unit tests 9,316 in 42 s (about 90 ms per file: fine). Backend e2e: 593 suites, serial, about
5.6 s per suite on average over the first 84, and a long tail: 35 of the first 80 suites took over 5 s; `assistant.e2e-spec.ts` took 106 s (15 tests) and
`assistant-limits.e2e-spec.ts` 61 s (18 tests), about 38% of the elapsed time for two files. Whole sweep estimated at about 50 minutes.

Found in the code (not yet measured):

- Every e2e `beforeEach` calls `SeedsService.clean()` (`test/seeds/seeds.service.ts`): it reads `information_schema`, then runs `TRUNCATE ... RESTART IDENTITY
CASCADE` on every table of the public schema, then runs the registered cleaners (Scylla tables, Dynamo items, a Redis flush, queue purges). That is a
  per-test cost, and it also makes parallel runs on one database impossible: two workers would wipe each other's rows.
- Parallel plan options: (a) shards, `jest --shard=i/N`, each with its own test stack (no test rewrite; memory about 5 GB per stack); (b) a database
  per worker plus per-worker Redis DB, Scylla keyspace, Dynamo tables, queue and topic names (a large change). `jest-e2e.json` has no maxWorkers; the
  package script and the checkpoint force `--runInBand`.
- Sleeps in `assistant.e2e-spec.ts`: three fixed waits (2.5 s, 1.5 s, 0.6 s), plus ten `waitFor` polls.
- Next measurements (after the checkpoint, on the idle VM stack): run 3 to 10 suites with `--verbose` and a timer around `beforeAll`, `beforeEach`
  (`clean()`) and the tests; the assistant pair first. Then the browser suite: Playwright runs 2 workers, `next dev` compiles pages on demand, and the
  gate also builds a production bundle.

## 10. Plan for the next session (agreed 2026-10-20)

Order, with the reasoning of this session:

1. A permanent per-suite timing reporter for the backend e2e sweep and the gates, and the same for Playwright (browser) tests: load, `beforeAll`,
   resets, each test, slowest tests, written to a file on every run. The throwaway hook used today is `/tmp/prof/hook-timer.js` (not in the repo).
2. Postgres reset: truncate only tables that hold rows (one query, about 35 ms for 233 tables, finds them). The FK graph is shallow (64 FKs;
   `TRUNCATE ... CASCADE` from `User` empties 15 tables, `Shop` 8, `BisOrder` 5), so integrity is kept by the cascade. Caveat: sequences of
   skipped tables are not restarted. Measure the real saving first (estimate: about 6 minutes of a 40-minute sweep).
3. Look at the slowest suites with the reporter (assistant 63 s of real test work, asset-upload 18 s, webhooks-wiring 8 s), the fixed sleeps
   (`consumer-failures` 32 s, `task-queue` 29 s, `statement-export` 10 s) and the 20% of places that hold 80% of the time.
4. The same analysis for the browser tests (Playwright: 2 workers, `next dev` compiles pages on demand, the gate builds a production bundle too).
5. Shards: `jest --shard=i/N`, each shard with its own tjustest stack and ports (about 5 GB per stack; the laptop fits 2, the VM 2 to 3); the lighter
   variant shares Kafka, Elasticsearch and ClickHouse and gives each shard its own Postgres database (cloned from a template), Redis DB, Scylla
   keyspace, Dynamo prefix, index/topic/queue names. Needs a check of which names are hard-coded.
6. A Vitest spike on about 10 representative e2e suites, then go or no-go (Nest needs decorator metadata, i.e. an swc plugin; running files
   without module isolation is where the saving is, and it leaks state between files; Jest API use: `jest.spyOn` in 139 files, `jest.fn` in 34).

Done on 2026-10-20: the Scylla cleaner (`libs/infrastructure/cassandra/cassandra.module.ts`) truncates only tables that hold rows, in parallel:
`assistant-limits` 253 s to 20 s, `assistant` 269 s to 77 s; the one failure in `discussions-comments` (S25 AS-19) is the same with the old cleaner.
Environment facts: the test stack starts in about 2 minutes 20 seconds when nothing else runs; two Scylla instances at once exhaust the kernel's
async I/O limit (`fs.aio-max-nr` 65536 reached with the dev Scylla up); the migration can fire before Scylla answers (rerun
`pnpm --filter api run test:stack:migrate`).

## 11. Result of the 37-suite check of the Scylla cleaner change (2026-10-20, end of session)

Suites that mention Scylla, feeds, discussions, live comments or webhook attempts (37 files): 32 passed, 5 failed (428 of 433 tests pass), 14 minutes.

- `community/discussions-comments` (S25 AS-19): fails identically with the ORIGINAL cleaner (A/B done), so not caused by the change (183 s before, 47 s now).
- `community/discussions` and `community/discussions-votes` (S25 AS-24, AS-29, AS-19): same shape ("expected versus received" lists of 50 to 100 items
  around the frozen-clock concurrency tests). Probably the same pre-existing cause; the A/B with the original cleaner was NOT run. Do it before
  committing the cleaner change: copy `git show HEAD:packages/backend/libs/infrastructure/cassandra/cassandra.module.ts` over the file, run both
  suites, restore `/tmp/prof/cassandra.mine.ts` (or the diff of this file).
- `assistant/assistant-metering` (S46 AS-69): `Unknown table 'llm_requests'`: the ClickHouse table is missing in the local test stack (the
  `test:stack:migrate` step covers Postgres, Dynamo and Scylla only). Environment, probably. Check where ClickHouse tables are created.
- `catalog-sync/sync-feed-consumer` (S09 AS-26): `PlanLimitReachedError: The shop has reached the number of products its plan allows`. A plan limit
  from a later capability (S17/S18 entitlements) breaks an older test that creates many products on a default plan. A real cross-capability
  regression that the sweep exists to find; the test needs a plan that allows the products.

The cleaner change itself (uncommitted): `packages/backend/libs/infrastructure/cassandra/cassandra.module.ts`.

Front end: the unit tests (303 files) already run on Vitest, the end-to-end tests (87 spec files, desktop and mobile projects) on Playwright, with
`workers: 2`. Both runners have a built-in `--shard=i/N`. Browser shards need a backend per shard (API, dev stack, web server, about 8 GB each); on
one machine raising the Playwright workers and serving a production build instead of `next dev` is the cheaper first step. Timing data of the
browser suite: not yet analysed (no per-test report on disk); the per-suite reporter planned above covers it.

## 12. Added to the plan (owner, 2026-10-20, late): front end in the same batch, and more caches

- Front-end shards in the same work item as the backend shards. A browser shard is a whole backend slice (API, workers, Next server, stores), so it
  needs the same per-shard isolation layer (Postgres database cloned from a template, Redis DB, Scylla keyspace, Dynamo prefix, index/topic/queue
  names); build it once for both. Use the production bundle for the browser suite: build once (cached by a hash of the web and contracts sources),
  serve on N ports; this also removes the on-demand compile of `next dev`.
- Browser tests log in through the UI: `register(page)` in `packages/web/tests/helpers.ts` fills the sign-up form and then logs in through the
  login form; 78 call sites, no `storageState`. Create user and session through the API and inject the cookie; keep a few real UI sign-up and login
  tests. Estimated 10 to 15 minutes of worker time, NOT measured.
- Fresh runners start cold: Jest cold compile 2.98 s versus 1.15 s warm per file (about 18 minutes over 593 files), and swc halves the cold
  compile (1.46 s). Bake the Jest cache, `.next/cache` and the Playwright browsers into the runner image.
- Affected-test selection: `jest --findRelatedTests` selects 15 to 35% of the e2e suites for a domain change, 82% for shared infrastructure
  (`outbox.service.ts`); the web build and the browser batches could skip themselves by fingerprint like the backend core gate does.
- Already done, no gain left: the test Postgres runs with `fsync=off`, `synchronous_commit=off`, `full_page_writes=off` on tmpfs.

## 13. Vitest spike: go or no-go rule (owner agreed 2026-10-20: do it if it wins 10 to 15 minutes)

Convert about 10 representative backend e2e suites (`bff`, `assistant`, `cart`, a `worker` wiring suite, an infrastructure suite, a few mid-size
domain suites) to Vitest with module isolation off and an swc plugin for decorator metadata (Nest needs `emitDecoratorMetadata`; swc is already a
dependency). Measure on the same stack with warm caches: (1) per-file load cost (today 1.1 to 2.9 s; target under about 0.4 s after the first
file), (2) total time of the 10 suites, Jest versus Vitest, (3) stability: run the set in three different orders; every test must pass in every
order (isolation off can leak state between files). GO if the projected saving over 593 files is at least 10 minutes and all three orders pass;
otherwise NO-GO or a smaller step. The front end already runs on Vitest (`packages/web/vitest.config.ts`), a working config to start from.
The 10-minute estimate is 1.1 s per file (probe) times 593 files, not yet measured on real suites.
