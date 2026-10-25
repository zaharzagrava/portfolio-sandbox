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

12. `fault-injection`: break things in the middle of an action: stop or pause the database, Redis, the message queue, search or storage while a seller saves, uploads, changes stock or reads orders (Docker `pause`/`stop` of that one container, or a proxy that drops or delays calls). Check: the screen says something honest (never a fake success, never an endless spinner), a retry after the service returns works exactly once, and the data is consistent afterwards (no half-written rows, no lost outbox messages, no duplicate). Runs on the dev stack with each service paused in turn; results are Playwright specs plus a small runner `scripts/aiqa/tracks/fault-injection/`.
13. `odd-data`: 10,000 products in one shop, 5,000 orders, names in other scripts (Cyrillic, Arabic, CJK, emoji, right-to-left, very long words, zero-width characters), huge and tiny numbers, every currency fraction size (0, 2, 3 digits), rounding edge prices (0.29, 1.15, 19.99, 999999.99), other time zones around midnight UTC. A seed script `scripts/aiqa/tracks/odd-data/seed.mjs` builds the data; testers and Playwright specs check lists, search, paging, money and dates on it.
14. `flaky-history`: every run of the Playwright and backend suites appends one line per test (name, result, duration, date, commit) to a history file; `scripts/aiqa/flaky.mjs` prints tests that failed and passed on the same commit, or failed more than once in the last 20 runs. A test on that list is a bug to investigate, never to retry.

## Parked (do later, owner agreed)

- Migration test: data written before a database change must still show correctly after it (old rows, old shapes). To write when the next schema change lands.
- API change check: compare the API description (`GET /v1/openapi.json`) before and after a change and fail on breaking changes the web app depends on. To add when API changes start; there are none yet.

- Dev-server-only findings are accepted as duplicates of production questions until `prod-build` has re-checked them.

## Order of a full round

1. Map-driven pass over all maps (testers), then confirm findings by hand.
2. Fixer (gaps and bugs) with permanent tests, then re-check the touched lines.
3. Tracks 3, 4, 6, 9 (tests in normal suites; need the QA stack for Playwright parts, the backend test stack for backend parts: swap stacks, never both).
4. Track 2 mutation (needs the test stack for the backend part; web part needs nothing).
5. Track 5 prod build: monkey, fuzzer, re-check of dev-only findings.
6. Tracks 12 and 13 (fault injection, odd data), track 11 security scanners; track 8 coverage read-out (new map lines for unexecuted code, testers run them).
7. Track 1 planted bugs: measure the whole flow.
8. Track 10 fresh-seed pass.
9. Track 7 human pass by the owner.
10. Repeat until a full round, including the fresh-seed pass, finds nothing new and all usual suites are green.

## The only things that keep this flow from being perfect (owner's list, 2026-10-25)

Everything else is supposed to be done by the tracks above. These stay open on purpose:
- Speed under load (k6 load tests): written down, to do later.
- Real users on a live app, with monitoring and a slow rollout. Big companies get most of their confidence there.
- A human clicking through once (`human-pass.md`).
- Real mail and payments instead of fakes (the invitation mail that never reaches the dev mailbox must still be explained while testing).
- A review by a model from a different company, to cover the blind spots of Claude testing Claude (postponed by the owner).
