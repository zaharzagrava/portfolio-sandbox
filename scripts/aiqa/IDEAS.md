# Ideas to improve AI QA beyond the current flow

Written 2026-10-25. Plain language. Each idea says: what it is, what it catches that the current flow misses, how to run it here, cost, and a verdict.

## What the current flow already does, and its blind spot

The current flow is: a coverage map (spec -> UI -> API -> DB), a random "monkey" clicker, an API fuzzer, and a fixer agent behind a guard script.

Its one big blind spot: every part of it is judged by a model reading the same spec. If the spec is wrong, or the model misreads it the same way every time, nobody notices. It also only finds bugs that show up when a tester tries a thing once. It does not find bugs that need many runs, many users at once, or a specific bad timing.

## What this repo already has (checked in package.json and the tree)

- `scripts/mutation/mutate.py` and `changed.sh`: a home-made mutation tester for backend files (jest). Its header says Stryker was skipped because of path aliases and ts-jest wiring.
- `fast-check` is already a backend dev dependency, and there is at least one property test (`libs/infrastructure/serverless/batch/sqs-batch.property.spec.ts`).
- `@axe-core/playwright` is already a dev dependency of `packages/web`, and `tests/app-shell.prod.spec.ts` uses it.
- Visual tests exist: `packages/web/tests/visual/` (orders, checkout, assistant) and `app-shell.visual.spec.ts`, using Playwright screenshot comparison.
- k6 is installed and `scripts/bench/statements-read.k6.js` exists; there are also two heavy bench scripts.
- The public API publishes `GET /v1/openapi.json` (apps/public-api) and a Swagger page at `/docs`.
- `docs/security/owasp-api-top-10.md` exists (a written review, not a scanner).
- Backend `check:*` scripts (module graph, table ownership, no wall-clock, and so on) act as architecture guards.
- Tests: backend jest (unit) plus vitest e2e (`test:e2e`), journeys (`test:journeys`), web vitest and Playwright.
- No Semgrep, no Schemathesis, no ZAP installed on this machine (only docker and k6 were found).

Words used below:
- "Oracle" means the thing that tells a test what the right answer is. Example: the test says "total should be 30" - the 30 is the oracle. If the oracle is wrong, a passing test proves nothing.
- "Mutant" means a copy of the code with one small deliberate mistake, like `>` changed to `>=`.

---

## 1. Mutation testing (Stryker)

What it is: make a small deliberate mistake in the code, run the tests, and see whether any test fails. If all tests still pass, that line is not really tested. Example: change `price * qty` to `price + qty`; if the tests still pass, nothing checks the total.

What it catches that the flow misses: weak or fake tests. This is the best answer to the problem "AI wrote the code and also the tests, and the tests just repeat the code". It does not find product bugs directly. It tells you where the safety net has holes, so you know where to point the QA agents.

How to run it here:
- Backend: you already have `python3 scripts/mutation/mutate.py <file.ts> --max 20` and `scripts/mutation/changed.sh origin/master`. Keep using it; it is cheap and already works with the repo's jest setup. Run it on money, stock, permission and state-change files first (orders, inventory, billing, auth).
- Web: add Stryker, because the home-made tool only covers backend. In `packages/web`: `pnpm add -D @stryker-mutator/core @stryker-mutator/vitest-runner`. Add `stryker.config.json` with `testRunner: "vitest"`, `mutate` limited to `lib/**/*.ts` and pure logic in `components/` (skip pages, layouts, styles), `coverageAnalysis: "perTest"`, `incremental: true`, `thresholds: { break: 60 }`. Run `pnpm exec stryker run`. Web unit tests use vitest 3.2.x, which the Stryker vitest runner supports (a third-party search said v1 to v3; confirm against the official Stryker docs before relying on it, and note an open bug report about noisy incremental files with the vitest runner: stryker-js issue 6004).
- Backend with Stryker: possible with `@stryker-mutator/jest-runner`, but the repo uses path aliases and ESM (`--experimental-vm-modules`), which is exactly why the in-house tool exists. Not worth fighting; skip.

Cost: low to medium. Setup for web about half a day. Runtime: run only on changed files (incremental) or on a chosen folder; a few hundred mutants take 5 to 30 minutes. Each survivor can be handed to an agent: "write a test that fails on this mutant".

Recommendation: DO NOW for web (add Stryker on `lib/`), and keep the backend script as the main tool, pointed at the riskiest files. Reason: it is the only practice that directly measures whether AI-written tests can be trusted.

---

## 2. Property-based testing (fast-check)

What it is: instead of writing "for input 3 the answer is 9", you write a rule that must always hold ("a refund never exceeds the amount paid") and the tool tries hundreds of random inputs, then shrinks a failure to the smallest example.

What it catches that the flow misses: edge cases nobody listed - zero, negative, huge numbers, unicode names, empty lists, rounding of cents, same item twice. The monkey and the fuzzer do random input at the screen/HTTP edge; this does it deep inside the logic where it is fast (thousands of tries per second).

How to run it here: `fast-check` is already installed in backend (`^4.10.2`). Add it to `packages/web` too (`pnpm add -D fast-check`). Put `*.property.spec.ts` files next to the code, like the existing sqs-batch one. Good targets, with the rule to check:
- money math (tax, fees, discounts, payout splits): total of the parts equals the whole; never negative; rounding never loses or invents a cent.
- stock: after any sequence of reserve/release/sell, stock is never below zero and equals start minus sold.
- order state machine: random sequence of events never reaches an illegal state.
- pagination and filters: pages joined together equal the full list, no duplicates.
- parse/format round trips: save then load gives the same value (zod schemas in `packages/contracts`).
- model-based testing (fast-check `commands`): random list of actions on a small fake model versus the real service.

Cost: low. One hour per rule once the first one exists. Agents write these well, but make them write the rule from the spec text, not from the code (see section 10).

Recommendation: DO NOW. Reason: cheap, library already present, and finds exactly the rounding and boundary bugs AI code tends to have.

---

## 3. Contract testing against the OpenAPI / spec

What it is: the written API description says "this endpoint returns `{id: string, total: integer}`". A contract test checks the real server answers match the description, and that the web app only sends and expects what the description allows. Example: the description says `total` is an integer, the server sometimes returns `"12.50"` as text.

What it catches that the flow misses: the API and the screen drifting apart; fields that exist in one layer and not the other; error responses with a different shape than documented. The coverage map checks each control end to end, but it does not systematically compare every response with a machine-readable promise.

How to run it here: two sources of truth exist. The public API has `/v1/openapi.json`. Everything else shares zod schemas in `packages/contracts` (used by both web and backend). So:
- Public API: validate live responses against the document. Easiest is Schemathesis (section 5), which does this by default.
- Internal API (web to backend): add a test helper that parses every real response in the Playwright e2e run with the matching zod schema from `packages/contracts` and fails on mismatch (`schema.strict().parse(body)` catches extra or missing fields). Intercept via `page.on('response')` in a shared Playwright fixture. This is about 40 lines and works on every existing e2e test for free.
- Optional: Pact consumer/provider tests. Overkill for one developer with a shared contracts package; skip.

Cost: low for the fixture (half a day), low for Schemathesis.

Recommendation: DO NOW for the Playwright fixture that checks all responses against the zod contracts; Schemathesis for the public API with item 5. Reason: turns every existing test into a contract check at near-zero cost.

---

## 4. Differential and metamorphic testing

What it is:
- Differential: run the same input through two ways of computing the answer and compare. Example: the SQL totals query versus a plain JavaScript sum over the rows; or the old code path versus the new one.
- Metamorphic: when you do not know the right answer, you know how two answers must relate. Example: searching "red shoes" with a price filter must return a subset of searching "red shoes" with no filter; sorting twice gives the same result; adding an item then removing it returns the cart to its start; order total in USD times the rate equals total in EUR.

What it catches that the flow misses: bugs where no one knows the exact right answer in advance, which is the case for search, filters, sort, paging, reports, dashboards totals and currency. It also gets around the oracle problem (section 10) because you compare the system with itself.

How to run it here: write them as fast-check properties (section 2) against the API in the vitest e2e setup (`pnpm --filter backend test:e2e`) or as small scripts next to `scripts/qa/fuzz-seller-api.mjs`. Good first set: filters are subsets, page 1 + page 2 equals the first 2N rows, dashboard total equals the sum of the order list, list count equals the count shown in the header, stock shown equals stock in DB after a sequence of edits, the same query as seller A and as seller B never leaks the other seller's rows.

Cost: medium. Needs thinking about the relations; an agent can propose relations from the spec, a human skims them. A dozen relations cover most of the value.

Recommendation: DO NOW, a small set (about 10 relations on list, search, totals, permissions). Reason: finds wrong-numbers bugs, which are the worst kind in a marketplace and are invisible to click-through testing.

---

## 5. Schema-based API fuzzing (Schemathesis, RESTler)

What it is: tools that read the OpenAPI description and generate many requests - valid ones, boundary ones, and invalid ones - and check for 500 errors, responses not matching the description, and rejected-but-should-pass inputs. RESTler (Microsoft) also chains calls (create, then read, then delete) to reach deeper endpoints.

What it catches that the flow misses: the current fuzzer is hand-written for the seller API. Schemathesis covers every endpoint in the document, checks response shape, and finds "server crashes with 500 on weird but legal input" systematically.

How to run it here (needs the stack up via `scripts/qa/stack-up.sh`):
- `docker run --rm --network host schemathesis/schemathesis run http://localhost:<public-api-port>/v1/openapi.json --checks all --max-examples 200` (use the real port from the stack). Add `--header "Authorization: Bearer <test key>"` for protected endpoints, and use the stateful option to follow links between calls.
- It only sees what is in the OpenAPI document. The internal web-to-backend API has no such document. Option: generate one from the zod contracts (e.g. `zod-to-openapi`), or skip those and rely on the hand fuzzer.
- RESTler: heavier (Linux binary, compile the grammar, fuzz step). Skip unless Schemathesis plateaus.

Cost: low (one hour to first run). Findings need triage; many will be "document is wrong", which is also useful.

Recommendation: Schemathesis DO NOW on the public API; RESTler SKIP. Reason: nearly free and covers all endpoints; RESTler adds little for a single small API.

---

## 6. Accessibility scanning (axe)

What it is: an automatic scanner that checks pages for known accessibility problems - missing labels on inputs, low colour contrast, buttons with no name, wrong heading order. Example: an icon-only "delete" button with no text for screen readers.

What it catches that the flow misses: all of it; the coverage map checks that controls work, not that they are usable with a keyboard or a screen reader. AI-written UI often has unlabelled icon buttons and poor contrast. Axe finds about a third of real accessibility problems; keyboard tests find more.

How to run it here: `@axe-core/playwright` is already installed and used once. Make it a fixture: after every `page.goto` or major state change in the dashboard tests, run `new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa']).analyze()` and fail on violations. Do it in dark mode and at phone width too. Add a Playwright "Tab through the page" test per dialog (focus goes in, Esc closes, focus returns). Run: `pnpm --filter web test:e2e`.

Cost: low. Expect a first wave of 20 to 100 violations, then it settles.

Recommendation: DO NOW. Reason: already installed, cheap, and a category the whole current flow ignores.

---

## 7. Visual regression

What it is: take a screenshot of a page, store it as the "golden" copy, and flag a pixel difference on later runs. Example: a CSS change makes the price overlap the photo; no functional test notices.

What it catches that the flow misses: layout breaks, overlap, cut-off text, wrong theme colours, broken phone layout.

How to run it here: already set up (`packages/web/tests/visual/`, `app-shell.visual.spec.ts`, Playwright `toHaveScreenshot`). Extend to the pages that have bugs in the QA register (inventory, orders, photos) at 3 widths and light/dark. Keep the screenshots tied to one OS (the Docker Playwright image) or they differ between machines. Mask dynamic parts (dates, ids) with `mask:`. Add a rule for agents: a fixer that changes UI must regenerate and look at diffs, never auto-accept them.

Cost: medium - upkeep. Every deliberate UI change means reviewing diffs.

Recommendation: LATER (extend only after the pages settle). Reason: it already exists; more of it now creates noisy churn while the UI still moves. Do the extension once the QA rounds finish.

---

## 8. Security scanning (ZAP, Semgrep, dependency audit)

What it is:
- Semgrep: reads source code for risky patterns (SQL built from strings, missing auth decorators, unsafe `dangerouslySetInnerHTML`).
- OWASP ZAP: attacks the running app from outside (injection, missing headers, cookie flags, open redirects).
- Dependency audit: checks packages for known holes.

What it catches that the flow misses: the monkey and fuzzer look for crashes; they do not look for "user A can read user B's order" (broken access control, the top web risk), injection, missing security headers, secrets in code. `docs/security/owasp-api-top-10.md` is a reading, not a test.

How to run it here:
- Semgrep: `docker run --rm -v "$PWD:/src" semgrep/semgrep semgrep scan --config p/typescript --config p/nodejs --config p/owasp-top-ten --config p/secrets packages/backend/libs packages/web/app packages/web/lib`. Add one custom rule: every NestJS controller route must have a guard or an explicit public marker (this is a classic AI omission). Takes minutes.
- ZAP: `docker run --rm --network host -t ghcr.io/zaproxy/zaproxy:stable zap-api-scan.py -t http://localhost:<port>/v1/openapi.json -f openapi` against the stack (baseline scan `zap-baseline.py -t <web url>` for the web). Run against the test stack only.
- Access control test by hand-made script: for every endpoint, call it with seller A's token on seller B's ids; expect 403/404. Generate the list of endpoints from the Nest routes. This is the highest-value security test and neither tool does it for you.
- `pnpm audit --prod` for dependencies.

Cost: Semgrep low; ZAP low to medium (noise); the cross-seller script medium.

Recommendation: DO NOW for Semgrep and the cross-tenant (A reads B) script; ZAP LATER. Reason: marketplaces are multi-tenant, so one seller seeing another's data is the key risk; ZAP mostly reports headers and noise at this stage.

---

## 9. Concurrency and race testing

What it is: do the same thing many times at the same moment and check the result. Example: two buyers buy the last item at once; both succeed and stock goes to -1. Or one webhook delivered twice, creating two payouts.

What it catches that the flow misses: everything involving timing. Testers act one step at a time, so check-then-act bugs (read stock, then write stock) never show.

How to run it here:
- Small script or vitest e2e test using `Promise.all([...Array(20)].map(() => fetch(...)))` against the test stack: buy last item x20, apply same coupon x20, double-click submit (same idempotency key twice), edit the same product from two sessions, send the same webhook 5 times. Assert: exactly one success, stock >= 0, no duplicate rows (check DB with a unique-count query).
- Property-style: fast-check has `fc.scheduler()` to explore orderings of async steps in unit tests.
- Check the idempotency code in `libs/infrastructure/http-client/` and the job handlers for same-key retries.
- Playwright: `await Promise.all([page.click(), page.click()])` for double-submit on the UI.

Cost: medium. Needs the real database (the existing e2e stack). A dozen scenarios are enough.

Recommendation: DO NOW for the 10 or so money/stock/idempotency scenarios. Reason: highest-severity class (lost money, oversold stock), and current flow cannot see it by design.

---

## 10. Chaos and fault injection

What it is: break a dependency on purpose and see whether the app behaves. Example: the payment provider times out; the database connection drops; the queue is slow; the disk is full.

What it catches that the flow misses: missing retries, half-finished orders (charged but no order), endless spinners, error pages leaking stack traces, data left inconsistent after a crash.

How to run it here: the backend has "provider doubles" (`PROVIDER_DOUBLES=enabled`, used in `start:load-test`). Make the doubles configurable to fail: return 500, hang 30 seconds, return malformed JSON, answer twice. For infrastructure use Toxiproxy (`docker run shopify/toxiproxy`) between the app and Postgres/Redis/queue to add latency or cut the link; or simply `docker pause <container>` and `docker kill` mid-checkout. Then check three things: the user sees a sensible message, no half-state in the database, and after recovery things finish (retry, outbox). Also test "kill the backend between payment confirmed and order saved".

Cost: medium to high. The double-failure switches are the cheap part and give most of the value.

Recommendation: LATER, start with failing provider doubles for checkout and payouts. Reason: valuable but needs the main happy-path and race bugs fixed first, otherwise it drowns in known noise.

---

## 11. The test-oracle problem when the same model writes and tests

What it is: if one model writes the code and the test, a misunderstanding is copied into both, and the test passes. Example: the spec says "free shipping at 50 or more"; the model reads "over 50" in both; the boundary test at exactly 50 agrees with the bug.

What it catches that the flow misses: systematic misreadings, which are the dominant failure of AI-built software.

What to do (practical ways):
- Derive expected values from the spec text before looking at the code: a "spec-only" tester agent that is given the spec and the screen/API but never the source, and writes expected results first, then compares.
- Use different models or at least different prompts for builder, test writer, and QA agent (see section 12).
- Use oracles that do not depend on the model: invariants (section 2), self-consistency (section 4), the database as a second witness, a trusted calculator for money (a tiny independent function written in different style, or a spreadsheet with a few hand-computed cases).
- Boundary table from the spec: for each number in the spec (limits, fees, days), force a test at limit-1, limit, limit+1, written by the spec-only agent.
- Mutation testing (section 1) shows whether tests have teeth.
- Keep a small hand-verified "golden" set (10 to 20 cases the developer computed personally) and run it always.

Cost: low (process change), plus the cost of the other items.

Recommendation: DO NOW, as a rule inside the existing tester prompt: tester must write the expected result from the spec before looking at the code, and must cite the spec line. Reason: no tooling cost and attacks the root weakness.

---

## 12. Independent-model cross-review

What it is: a different model (or the same model with a very different role and no shared context) reviews the diff, the tests, or the bug verdicts. Example: the fixer says "bug B-040 fixed"; another model reads only the bug text and the diff and answers "does this really fix it, and what did it break".

What it catches that the flow misses: the fixer marking its own work as good; wrong "not a bug" verdicts; tests that were weakened to go green (a very common AI shortcut). The guard script helps, but only for what it knows to check.

How to run it here: add a step after each fix: a reviewer agent gets (bug text, diff, test diff) and has two jobs: (a) try to break the fix; (b) flag any removed or loosened assertion. Use a different model family if available (for example run the review through another vendor's CLI) or at least a fresh Claude session with a sceptical prompt. Add a mechanical rule to the guard script: fail if a test file loses assertions (`git diff --numstat` plus a grep for deleted `expect(`), or if `.skip`, `xit`, `retries`, or a bigger timeout appears in the diff. Also have a second model audit a random 10 percent of `pass` lines in the coverage map by redoing them.

Cost: low to medium (more tokens per fix).

Recommendation: DO NOW for the "weakened test" guard rule and the reviewer step; the random re-audit of passes LATER. Reason: protects the trust in every number on the scoreboard.

---

## 13. Spec-versus-code drift checking

What it is: automatically detect that the written spec and the code no longer say the same thing. Example: the spec lists 5 order statuses, the code has 6.

What it catches that the flow misses: the mapper already compares spec and code once per area (the `*.gaps.md` files). Drift returns after every fix. Machine-checkable parts can be checked on every run.

How to run it here:
- Statuses, roles, error codes, limits: extract them from the spec (`specs/domains`, `docs/spec`) into a list and compare with the zod enums in `packages/contracts` using a script. The repo already has `pnpm docs:check` (`scripts/docs`) and `check:*` guards; extend them.
- OpenAPI document versus Nest routes (Swagger is already generated by `@nestjs/swagger`): diff the endpoint list against the controllers.
- Spec-tagged tests: each test names its spec id in the title; a script lists spec ids with no test and tests with an id that no longer exists. The coverage map already has spec ids, so check the map file against the spec headings on every run.
- Spec-to-code "reverse read": a model reads only the code for one feature and writes the rules it sees in plain words; a second model diffs that against the spec.

Cost: low to medium.

Recommendation: LATER for the reverse read; DO NOW for the cheap scripted checks (enums, routes, spec ids). Reason: scripted checks cost little and the map depends on spec ids staying correct.

---

## 14. Flaky test quarantine

What it is: a flaky test sometimes passes and sometimes fails with no code change. Quarantine means: automatically detect them (rerun failures), move them to a separate list that does not block, and track them until fixed.

What it catches that the flow misses: with a fixer agent behind a guard script, a flaky test is dangerous in two ways. It blocks good fixes, and an agent may "fix" it by adding sleeps or retries that hide a real race bug.

How to run it here: Playwright already supports `retries` and reports `flaky` status in its JSON reporter; keep `retries` at 0 locally and 1 on the guard run, and record every test that passed only on retry into a file (`scripts/qa/flaky.tsv`). Vitest/jest: `--retry` equivalents are available; same file. Rule: never auto-edit a flaky test to add waits; instead file a bug (many flakes are real races, see section 9). Run the guard suite 3 times nightly on the base branch to find flakes.

Cost: low.

Recommendation: DO NOW (just the record and the "no sleep, no retry" rule in the fixer prompt). Reason: small, and it protects the guard script from being gamed.

---

## 15. Production-like load tests

What it is: run many users at once for some minutes against a realistic dataset and watch speed, errors, and memory. Example: 200 sellers loading the orders list with 100,000 orders in the database.

What it catches that the flow misses: slow queries that only hurt with real data (missing indexes, the N+1 problem where one list triggers one query per row), memory leaks, connection pool exhaustion, rate limit mistakes. Testers work with a handful of rows.

How to run it here: k6 is installed and `scripts/bench/statements-read.k6.js` exists as a model. Write k6 scripts for the top five read endpoints (orders list, product list with search, dashboard overview, product detail, checkout) with a seeded database (the two `scripts/bench/*.ts` scripts seed big data). Run `k6 run --vus 50 --duration 3m script.js` against the load-test stack (`pnpm --filter backend start:load-test` uses the provider doubles). Thresholds: p95 under a chosen limit, error rate under 1 percent. Check the Postgres slow query log or `pg_stat_statements` for the worst queries and `EXPLAIN` them.

Cost: medium. The seeded data and first scripts take a day; later runs are cheap.

Recommendation: LATER. Reason: the app is still being made correct; performance numbers are only worth tuning after behaviour is stable. Do a one-off check of list endpoints with 100k rows soon, since N+1 and missing index bugs are cheap to fix early.

---

## 16. Other ideas worth a line

- Snapshot of API responses ("golden master"): save real responses for a fixed scenario and diff them after each fix. Catches unintended side effects of fixes. Cheap; LATER.
- Database invariant checker: a SQL script that runs after every QA round and looks for impossible rows (negative stock, order with no items, payout bigger than sales, orphan photos). Cheap and very effective because the DB is a second witness. DO NOW.
- Time travel testing: the repo has a `check:no-wallclock` guard, so a fake clock presumably exists. Test subscriptions, expiry, scheduled jobs, and daylight saving by moving the clock. LATER.
- Log and console watch: during all UI testing, fail on any browser console error and any server log at error level. Almost free in Playwright (`page.on('console')`, `page.on('pageerror')`). DO NOW.
- Fixer regression budget: after each fix, rerun the earlier bug reproduction scripts (`scripts/qa/regress.sh` appears to be this). Keep doing it.
- Mutation-testing the QA process itself: plant 5 known bugs in a branch and see how many the flow finds (a recall test of the testers). Cheap and gives an honest number on how good the QA flow is. DO NOW once.

---

## Ranked top 5 to add

1. Independent oracles and no-weakened-tests rule (sections 11 and 12). Zero tooling. Spec-only expected values, a reviewer step after each fix, and guard rules against deleted assertions, `.skip`, retries and longer timeouts. Reason: it protects the trust in everything else.
2. Concurrency and double-submit tests (section 9), plus the database invariant checker (section 16). Finds the highest-severity bugs (oversold stock, duplicate payouts, negative balances) that step-by-step testers cannot see.
3. Property-based and metamorphic tests on money, stock, filters, paging, totals (sections 2 and 4). fast-check is already installed; about ten relations give a lot.
4. Mutation testing, web via Stryker plus backend via the existing `mutate.py`, aimed at money, stock, permissions (section 1). Shows where AI-written tests have no teeth, and tells the QA agents where to look.
5. Security basics: Semgrep plus the "seller A reads seller B" script, with Schemathesis on the public API in the same session (sections 8, 5, 3). Multi-tenant leaks are the worst product risk and the current flow does not look for them.

Close runners-up: axe as a Playwright fixture (section 6, quick and already installed), the contract fixture that checks every e2e response against the zod schemas (section 3), and the one-off "plant 5 bugs" recall test (section 16).
