# Extra tracks (besides the map-driven exploratory pass)

Decided with the owner on 2026-10-25. First built and run on the four areas (entry, inventory, media, orders), then reused for every other page. Each track lives in `scripts/aiqa/tracks/<name>/` with its own README, and runs from `scripts/aiqa/run-track.sh <name>` (to build).

## The tracks

1. `planted-bugs`: a kit that hides 5 realistic bugs in a throwaway copy of the code (one per kind: wrong rule, missing check, bad boundary, lost update, leaked data), runs the AI QA flow, and counts how many it found. Measures "can the AI fully test this". Run once per round of improvements.
2. `mutation`: breaks the code on purpose (change `>` to `>=`, delete a check) and checks that some test fails. Surviving mutants are tests that do not really guard anything. Web logic files: Stryker (check it works with the repo's Vitest). Backend: the in-house `scripts/mutation/mutate.py`. Start with money, stock, filters, paging, permissions of the four areas.
3. `concurrency`: double clicks, two tabs, parallel requests on the same product or order, plus a database check for impossible rows (negative stock, duplicate rows, orphans). Lives in the normal suites (Playwright for screens, backend end-to-end for server behavior).
4. `seller-isolation`: seller A must not read or change anything of seller B on every endpoint of the four areas (list, read, write, ids from the other shop, cursors from the other shop). Lives in the normal suites.
5. `prod-build`: run the web app as a production build, then run the monkey tester (`scripts/qa/monkey-seller.mjs`) and the API fuzzer (`scripts/qa/fuzz-seller-api.mjs`) against it, and use it to re-check every dev-server-only finding (CSP console errors, hydration errors, 404 status codes).
6. `a11y-browsers`: an accessibility scan (axe) of every page state in the four areas and a run of the Playwright tests of the four areas in Firefox (Safari/WebKit dropped by the owner for now) as well as Chromium.
7. `human-pass`: a short list for the owner to click through at the end: look and feel, wording, things only a person judges. Generated from the maps (`scripts/aiqa/human-pass.md`).

8. `code-coverage`: turn on code-coverage recording in the running app (web: V8 coverage through Playwright / `NODE_V8_COVERAGE` on the server; backend: V8 coverage of the API process) while the testers and the permanent tests run, then list the code of the four areas that nothing ever executed. Each unexecuted piece becomes a new map line (or a justified `n/a`). Answers "did we really test everything".
9. `stateful`: rule-based random tests (fast-check model/command testing for the backend and for pure logic; for screens a small random-action runner on top of Playwright). The rules are written once ("stock never below 0", "an archived product is never shown to buyers", "a version only goes up by 1", "totals equal the sum of the lines"); the tool runs thousands of random action sequences and checks the rules after every step, and shrinks a failure to the shortest sequence.
10. `fresh-seed-pass`: after a round is clean, run the whole map pass again with a different seed (different data, different random choices, different tester agents). The number of new findings compared with the first pass shows how much a single pass misses. A round is only closed when the fresh-seed pass finds nothing new.
11. `security`: scanners on the four areas: Semgrep (code rules, run from Docker), Schemathesis (API fuzz from the OpenAPI document `GET /v1/openapi.json`, run from Docker against the production-build stack), OWASP ZAP baseline scan against the production build (Docker), plus dependency audit (`pnpm audit`) and a secrets scan (gitleaks). Findings go to the register like any bug; real ones are fixed with a test.

12. `fault-injection`: freeze ONE helper service (database, Redis, Kafka, search, storage, queue ...) for under 5 minutes while the spec presses real buttons, then unfreeze and check: an honest message within 25 seconds, no fake success, one clean retry, data consistent, outbox published. Runner `scripts/aiqa/tracks/fault-injection/run.mjs`; map `coverage/fault-injection.tsv`; spec `packages/web/tests/aiqa/fault-injection.spec.ts` (skips itself unless the runner sets `AIQA_FAULT=1`).
13. `odd-data`: one throwaway shop with 10,000 products and 5,000 orders full of odd data (six scripts, emoji, right-to-left, 120-letter words, rounding prices, currencies with 0/2/3 decimals, instants around midnight UTC viewed from far time zones). Seed `scripts/aiqa/tracks/odd-data/seed.mjs`; map `coverage/odd-data.tsv`; spec `packages/web/tests/aiqa/odd-data.spec.ts` (skips itself without `/tmp/fe/odd-data.json`).
14. `flaky-history`: every run of the Playwright and backend suites appends one line per test (name, result, duration, date, commit) to a history file; `scripts/aiqa/flaky.mjs` prints tests that failed and passed on the same commit, or failed more than once in the last 20 runs. A test on that list is a bug to investigate, never to retry.

## Where every track lives (map, test, README)

Each track folder under `scripts/aiqa/tracks/<name>/` has a `README.md` in plain language: what it finds, prerequisites, how to point it at a new feature, commands, how to read results, how results become map lines/findings/register entries, known limits. Tracks that have a map of their own use the same 10-column format and the same tools (`status.mjs`, `mark.mjs`, `run-specs.mjs`, fingerprints).

| Track | README | Map (`coverage/`) | Permanent test | Runs from |
|---|---|---|---|---|
| planted-bugs | `tracks/planted-bugs/README.md` | none (score) | `tracks/planted-bugs/probes/planted-probe.spec.ts` | `plant.sh`, `score.sh` |
| mutation | `tracks/mutation/README.md` | none (survivors become tests) | web: `lib/seller/*.mutation.test.ts`, `nav.test.ts`; backend: unit specs | `pnpm mutation:web`, `tracks/mutation/backend.sh` |
| concurrency | in the tests | lines in each area map | `packages/web/tests/seller-concurrency.spec.ts` (screens); backend: `libs/domains/catalog/product-concurrency.e2e-spec.ts`, `media/media-concurrency.e2e-spec.ts`, `orders/order-seller-concurrency.e2e-spec.ts` | Playwright; backend test stack |
| seller-isolation | in the tests | lines in each area map | `packages/web/tests/seller-isolation.spec.ts` (screens); backend: `libs/domains/catalog/product-isolation.e2e-spec.ts`, `orders/order-seller-isolation.e2e-spec.ts` | Playwright; backend test stack |
| prod-build | `tracks/prod-build/README.md` | none | monkey + fuzzer in `scripts/qa/` | `tracks/prod-build/run.sh` |
| a11y-browsers | in `a11y-seller.spec.ts` | lines in each area map | `packages/web/tests/a11y-seller.spec.ts`, `PW_BROWSERS=1` Firefox | Playwright |
| human-pass | `human-pass.md` | none | none | the owner |
| code-coverage | `tracks/code-coverage/README.md` | adds `<area>.coverage.*` lines | none | `tracks/code-coverage/report.mjs` |
| stateful | `tracks/stateful/README.md` | lines in each area map | `lib/seller/seller-logic.property.test.ts`, `product-lifecycle.stateful.e2e-spec.ts` | Vitest, backend test stack |
| security | `tracks/security/README.md` | none (`findings/security*.md`) | Semgrep rules + selftest | `tracks/security/run.sh` |
| fault-injection | `tracks/fault-injection/README.md` | `coverage/fault-injection.tsv` | `tests/aiqa/fault-injection.spec.ts` | `tracks/fault-injection/run.mjs` |
| odd-data | `tracks/odd-data/README.md` | `coverage/odd-data.tsv` | `tests/aiqa/odd-data.spec.ts` | `tracks/odd-data/seed.mjs` + Playwright |
| flaky-history | `tracks/flaky-history/README.md` | none | reporters in `tests/support/` and `backend/test/` | `scripts/aiqa/flaky.mjs` |

## A new feature: which tracks to run again

See "Adding a new feature to the flow" in `README.md`. Short form: map -> specs -> odd-data seed and map lines -> fault-injection actions -> isolation -> concurrency -> a11y -> security scope -> coverage report -> mutation targets.

## Parked (do later, owner agreed)

- Migration test: data written before a database change must still show correctly after it (old rows, old shapes). To write when the next schema change lands.
- API change check: compare the API description (`GET /v1/openapi.json`) before and after a change and fail on breaking changes the web app depends on. To add when API changes start; there are none yet.

- Dev-server-only findings are accepted as duplicates of production questions until `prod-build` has re-checked them.

## Order of a full round (revised 2026-10-25, owner asked to remove double work)

1. Map-driven passes finish (testers). Specs move to the final layout `packages/web/tests/seller/<area>/`.
2. Triage the findings, then FIX in one batch (`prompts/fixer.md`): cross-cutting fixes first, then one fixer per area in parallel. The unfinished backend race, isolation and stateful specs are finished here.
3. Usual suites green twice in a row, with ONE stack swap: test stack up, backend suite twice (includes the new backend specs); swap to the dev stack, front-end suite twice on both projects (includes every spec of the testers). Running the suites IS the re-check: there is no separate re-check step. The cache (`run-specs.mjs`, `recheck.mjs`, `snapshot-diff.mjs`) is for partial runs while fixing.
4. Final checks on the dev stack, in parallel: fresh-seed pass over the maps, production build with monkey tester and fuzzer, security scanners, odd-data and fault-injection maps re-run.
5. Measurements: backend mutation testing (test stack, so after step 4), planted-bugs round in its own checkout, code coverage read-out (new map lines for unexecuted code).
6. Human pass by the owner (`human-pass.md`).
7. If steps 4 or 5 find something new: small fix round, back to step 3. Done when a full round finds nothing new.

## The only things that keep this flow from being perfect (owner's list, 2026-10-25)

Everything else is supposed to be done by the tracks above. These stay open on purpose:
- Speed under load (k6 load tests): written down, to do later.
- Real users on a live app, with monitoring and a slow rollout. Big companies get most of their confidence there.
- A human clicking through once (`human-pass.md`).
- Real mail and payments instead of fakes (the invitation mail that never reaches the dev mailbox must still be explained while testing).
- A review by a model from a different company, to cover the blind spots of Claude testing Claude (postponed by the owner).
