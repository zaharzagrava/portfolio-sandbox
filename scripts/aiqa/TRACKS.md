# Extra tracks (besides the map-driven exploratory pass)

Decided with the owner on 2026-10-25. First built and run on the four areas (entry, inventory, media, orders), then reused for every other page. Each track lives in `scripts/aiqa/tracks/<name>/` with its own README, and runs from `scripts/aiqa/run-track.sh <name>` (to build).

## The tracks

1. `planted-bugs`: a kit that hides 5 realistic bugs in a throwaway copy of the code (one per kind: wrong rule, missing check, bad boundary, lost update, leaked data), runs the AI QA flow, and counts how many it found. Measures "can the AI fully test this". Run once per round of improvements.
2. `mutation`: breaks the code on purpose (change `>` to `>=`, delete a check) and checks that some test fails. Surviving mutants are tests that do not really guard anything. Web logic files: Stryker (check it works with the repo's Vitest). Backend: the in-house `scripts/mutation/mutate.py`. Start with money, stock, filters, paging, permissions of the four areas.
3. `concurrency`: double clicks, two tabs, parallel requests on the same product or order, plus a database check for impossible rows (negative stock, duplicate rows, orphans). Lives in the normal suites (Playwright for screens, backend end-to-end for server behavior).
4. `seller-isolation`: seller A must not read or change anything of seller B on every endpoint of the four areas (list, read, write, ids from the other shop, cursors from the other shop). Lives in the normal suites.
5. `prod-build`: run the web app as a production build, then run the monkey tester (`scripts/qa/monkey-seller.mjs`) and the API fuzzer (`scripts/qa/fuzz-seller-api.mjs`) against it, and use it to re-check every dev-server-only finding (CSP console errors, hydration errors, 404 status codes).
6. `a11y-browsers`: an accessibility scan (axe) of every page state in the four areas and a run of the Playwright tests of the four areas in Firefox and WebKit (Safari engine) as well as Chromium.
7. `human-pass`: a short list for the owner to click through at the end: look and feel, wording, things only a person judges. Generated from the maps (`scripts/aiqa/human-pass.md`).

## Parked (do later, owner agreed)

- Non-functional: speed under load (k6), security scanners (Semgrep, Schemathesis, ZAP), chaos and fault injection.
- Fake services: mail, payments, storage are doubles; real-provider checks belong to a later hardening step. The invitation mail not arriving in the dev mailbox must be explained (stack or bug) while testing `entry`/team.
- A second model family as independent reviewer (postponed by the owner).
- Dev-server-only findings are accepted as duplicates of production questions until `prod-build` has re-checked them.

## Order of a full round

1. Map-driven pass over all maps (testers), then confirm findings by hand.
2. Fixer (gaps and bugs) with permanent tests, then re-check the touched lines.
3. Tracks 3, 4, 6 (tests in normal suites; need the QA stack for Playwright parts, the backend test stack for backend parts: swap stacks, never both).
4. Track 2 mutation (needs the test stack for the backend part; web part needs nothing).
5. Track 5 prod build: monkey, fuzzer, re-check of dev-only findings.
6. Track 1 planted bugs: measure the whole flow.
7. Track 7 human pass by the owner.
8. Repeat until a full round finds nothing new and all usual suites are green.
