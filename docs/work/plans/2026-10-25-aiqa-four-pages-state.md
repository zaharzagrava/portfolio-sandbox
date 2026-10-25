# State at the end of 2026-10-25: AI QA of the four seller pages

Branch: `aiqa/fixes` (local, 69 commits after the test baseline `fd3a1645`; master has the docs commits; nothing pushed). Read `scripts/aiqa/README.md`, `TRACKS.md` and `docs/work/architecture/test-suite-rules.md` first.

## What exists

- Method and tools in `scripts/aiqa/`: coverage maps (`coverage/<area>.tsv`, 4 areas: entry 190 lines, inventory 178, media/photos 167, orders 131, plus odd-data and fault-injection maps), `status.mjs`, `mark.mjs`, cache (`fingerprint.mjs`, `recheck.mjs`, `run-specs.mjs`, `snapshot*.mjs`), prompts, tracks (`tracks/*`), `heavy.sh` (one heavy command at a time), `suite-run.md` (how to run both suites).
- Bug list: `docs/work/qa-bug-register.md` (B-001 to B-103, with statuses and decisions) and counts in `docs/work/qa-bug-scoreboard.md`.
- Click-through guide for the owner: `docs/work/human-test-guide.md` (accounts, URLs, what to try). Longer "does it feel right" list: `scripts/aiqa/human-pass.md`.
- ONE suite rule (owner, binding): `docs/work/architecture/test-suite-rules.md`: one FE and one BE suite for SDD and AI QA, scenario ids in titles, performance budget (FE about 9 to 10 minutes, BE about 12), test once, phone only for what differs (`@phone` / `@desktop` tags, projects use `grepInvert`), special runs gated by `AIQA_ODD`, `AIQA_FAULT`, `AIQA_SLOW`.

## Results so far

- Backend suite (6 shards): run 6 fully green (8,476 tests). Run 7 failed once on an unrelated old flake: `libs/infrastructure/jobs/jobs-retention.e2e-spec.ts` S49 AS-89 (heap growth after VACUUM; cause not found; deferred by the owner). Flakes found and fixed in runs 3 to 5: outbox-relay, onboarding-review, notifications-observability, ledger-hot-accounts (all test hygiene).
- Front end: full run 1 (976 tests, 19.9 min): 759 passed, 17 failed, 199 skipped. Failures were triaged and fixed (several were regressions of earlier fixes: route announcer crash, `overflow-wrap` on the shell, focus restore, search sort). The skips were the gated track specs; they are now out of the normal run. Full run 2 (808 tests) was stopped early at the owner's request: ok 173, fail 0, skip 9 of 808 when stopped (no failure at that point). It must be rerun in full.
- The owner clicked the four pages by hand: they work.

## Open items for tomorrow, in order

1. Read the result of the front-end full run (or rerun: `cd packages/web && API_URL=http://localhost:8000 npx playwright test --workers=3 --reporter=list`, stack up first, see `scripts/aiqa/suite-run.md`). Fix what fails, then a second clean run (green twice in a row). Known to watch: orders AS-84 (passed alone, failed under load), inventory AS-42 (test too long under load).
2. Right-sizing pass (tests only): move input/format/limit/copy tests from Playwright to unit or component tests (examples: money parsing AS-35, stock field validation AS-38, code-point title length AS-43, handle slug AS-02, unknown currency not crashing the orders table x3, cursor refusal is a backend test); merge the rest into journeys with several scenario ids; repoint the map lines (`aiqa-lines`) to the unit tests; target about 150 new browser tests (now about 450) and the whole FE suite near 9 to 10 minutes. Four agents (entry, inventory, photos, orders), one Playwright run at a time through `scripts/aiqa/heavy.sh`.
3. Measurements, never run yet: web mutation rerun on changed files (`pnpm mutation:web`, incremental), backend mutation (`scripts/aiqa/tracks/mutation/backend.sh`, needs the test stack, about 300 jest runs), planted bugs (`tracks/planted-bugs/`, own checkout and stack), code-coverage read-out (`QA_COVERAGE=1 WITH_WEB=1 scripts/qa/stack-up.sh`, then `tracks/code-coverage/report.mjs`). Run results go to the register.
4. Backend audit (owner parked it until the FE is settled): 287 scenario ids carried by two or more backend files plus the 8 new AI QA backend specs, to find real overlap, and the slowest files with fixed waits.
5. Decisions to confirm with the owner: second shop from the UI (today only through the API; the picker has no "open another shop" link; spec W04 B-01/B-04); AS-87 test counts "session ended" status once and allows up to 2 list calls (the product could skip the extra request); not-found pages answer HTTP 200 with noindex (B-026, spec FR-001 updated); emoji search finds nothing (B-088, accepted); Stock filter on archived products (B-033, accepted).
6. Left over: dependency advisories needing major jumps (nodemailer 8, OpenTelemetry, uuid, others; web audit 82 to 34 findings, critical 3 to 0); production-build run (monkey tester, fuzzer, ZAP, Schemathesis) to repeat in a later round; non-functional: load tests; real mail and payments; a model from another company as reviewer (postponed by the owner).
7. New idea from the owner, not started: a simple web page where a client asks for a feature and the flow runs by itself: grill the client, cross-check spec/tests/code, generate the spec-kit spec, client approves, SDD runs on a VM, then AI QA, then "ready, please check". Needs its own design.

## How to start again (one stack at a time; PC crashed once from running too many heavy jobs at once)

- Dev stack for the browser: `FORCE=1 bash scripts/infra/make-dev-env.sh`, then `mkdir -p /tmp/fe && QA_DIR=/tmp/fe WITH_WEB=1 scripts/qa/stack-up.sh` (about 5 minutes; do not wrap it in `heavy.sh`). Web 3000, API 8000. Stop: `scripts/qa/stack-down.sh /tmp/fe`.
- Backend test stack: `scripts/infra/stack.sh test setup` (stays attached and streams logs; the stack is ready at the line "test stack is up and migrated"), then `scripts/speedup/run-sharded.sh 6`. Stop: `docker compose -f docker-compose.test.yaml -p marketplace_test down`.
- Never both stacks together. One heavy command at a time through `scripts/aiqa/heavy.sh`. Do not `pkill -f` with a pattern that appears in your own command (it kills your own shell); kill explicit process ids.
- Owner accounts on the dev stack are lost when the stack is torn down (the database is throwaway): after a restart the seeded `seller@marketplace.local` and `admin@marketplace.local` (password `Demo-Seed-Pw-7491!`) exist again; register new users for the rest.
