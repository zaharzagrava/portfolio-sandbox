# AI QA: test a whole slice of the app, with a map of what was checked

Goal: find out if an AI can FULLY test a given set of pages on its own, and know exactly what it did and did not check.

## The idea in plain words

1. A **map** lists every single thing a person can do on the pages in scope: every button, toggle, field, link, menu entry, dialog, every flow, and every rule the spec states. One line per item.
2. Each line says: which spec rule covers it, which code file builds it, and the status: not tested / passed / bug found / blocked, with the date, who checked, and the bug numbers.
3. Testers go through the map until no line is "not tested". For each line they check ALL layers: what the screen shows, what the server answers, and what is in the database.
4. The spec is the starting list, but the spec can be behind the code (or the code behind the spec). So the mapper also reads the code and lists the differences. Things in code but not in spec get lines too, marked `code-only`. Things in spec but missing in code are bugs.
5. Every bug goes to `docs/work/qa-bug-register.md`; counts go to `docs/work/qa-bug-scoreboard.md`.

## Where things are

- `coverage/<area>.tsv`: the maps (tab-separated, one line per item). Columns: id, what, spec, code, layers, status, date, by, bugs, note.
- `coverage/<area>.gaps.md`: differences found between spec and code while mapping.
- `findings/<area>.md`: what testers report (bugs and suspicious things) before they go to the register.
- `prompts/mapper.md`, `prompts/tester.md`: the instructions for the two kinds of agent (so nothing is explained twice).
- `status.mjs`: prints how much of each map is checked (`node scripts/aiqa/status.mjs`, add an area name to list the open lines).
- `explore.sh <area>`: runs tester passes until the map has no "untested" line left (or the pass limit is reached).
- The stack, the monkey tester, the API fuzzer and the old charters stay in `scripts/qa/` (`stack-up.sh`, `monkey-seller.mjs`, `fuzz-seller-api.mjs`). The monkey and fuzzer are a second, random way; the map is the planned way.

## Statuses

- `untested`: nobody has checked it.
- `pass`: checked on UI, API and database (the `layers` column says which layers were really looked at).
- `bug`: checked, something is wrong; bug numbers in `bugs`.
- `blocked`: could not be checked (say why in `note`); counts as NOT checked.
- `n/a`: not testable by hand (explain in `note`), for example "unit-test-only".

A line may be `pass` only if the layers column lists ui, api and db (db only if the control writes or reads stored data).

## Areas in scope now

- `entry`: open-shop form, shop picker, shop switcher, dashboard shell (menu, banner, offline banner, drawer at phone width), sign-in redirect.
- `inventory`: product list, search, filters, paging, add product, edit, stock change, archive/restore, roles.
- `media`: product photos page (upload, order, remove, save, limits). Video is a later area.
- `orders`: orders list, filters, paging, empty and error states, money, privacy.

Later: overview-live, team, developers (keys, webhooks, logs, usage, API version), bulk import, video.

## Rules for every agent

- Plain language in reports.
- No `git stash`, `git reset`, `git checkout` of files. Do not commit; do not push.
- Never edit tests or product code while testing (fixing is a separate step).
- Write down what you tried even when it passed.

## Decisions made with the owner (do not ask again)

- Goal: prove whether an AI can FULLY test a slice of functionality on its own. Nobody has hand-tested these pages; the existing tests probably do not cover everything.
- Scope: four areas: `entry`, `inventory`, `media` (photos), `orders`. The page list was confirmed by the owner on 2026-10-25.
- The live page is the starting point, the spec is the baseline. Every button, toggle, link, field and state found on the page must be investigated and traced all the way down: spec -> UI -> API -> backend service -> database. Nothing may be left out because the spec does not mention it. The spec can be behind the code, so code is cross-checked and the differences go to `coverage/<area>.gaps.md`.
- The map is the record of what was checked and when. Testing is done when no line is `untested`; `blocked` counts as not checked and must be unblocked (for example, fix the stack) and run again.
- Testers do not stop in the middle of a flow. Passes continue (`explore.sh`) until the map is complete.
- Only confirmed bugs go to the fixer; the owner reads the findings first. Local commits only, never push.
- Rounds end when a full pass over every map finds no new real bug. Counts go to `docs/work/qa-bug-scoreboard.md`, each finding to `docs/work/qa-bug-register.md`.
- Other practices to add (mutation testing and more) are collected in `IDEAS.md`.

## Order of work

1. Mappers build `coverage/<area>.tsv` and `.gaps.md` from page + spec + code (this is step 1).
2. Owner skims the maps and gaps.
3. Testers: `scripts/aiqa/explore.sh <area>` per area (stack must be up: `QA_DIR=/tmp/fe WITH_WEB=1 scripts/qa/stack-up.sh`; one stack at a time, never together with the test stack).
4. Merge `findings/<area>.md` into the register and scoreboard; verify each bug by hand.
5. Fixer step for confirmed bugs, then rerun the touched lines.
6. Extra methods from `IDEAS.md`.

## More decisions (2026-10-25)

- No hard time limit on mapper agents: completeness over speed. Tester passes are sized by number of lines; a pass may run over its minutes to finish the line it is on.
- Independent grader: the agent that fixes a bug must not be the one that judges the fix. Use a different model (another Claude tier at least; another vendor's model if the owner has a CLI for it) for a review after every fix and for re-checking `pass` lines on a sample.
- From `IDEAS.md`, for the four areas first: (1) cross-model review and the "no weakened tests" guard; (2) double-click and parallel-request tests with a database check for impossible rows; (3) random-input / "must always hold" tests for money, stock, filters and paging; (4) mutation testing on money, stock and permission files; (5) security basics: seller A must not read seller B's data. Plant 5 known bugs once to measure how many the flow finds.
- Scope stays on the four areas until their maps are fully checked.

## Cache (re-map only what changed)

Idea from the owner: start each page with fixed seed data, save its HTML, and compare with the last saved copy; re-run mapping only for the parts that changed. Design:

- Every map line gets a `fingerprint`: a hash of (the page part's HTML with ids, dates and random strings removed) plus the hash of the code files in its `code` column.
- A snapshot script (`snapshot.mjs`, to build) opens each page with the fixed demo seed at 1280 and 390 px for each role and state, splits the HTML into parts (one per control or region), and stores `coverage/snapshots/<area>/<page>.json`.
- On the next run it compares: unchanged parts keep their status and date; changed or new parts become `untested` and go to the mapper again; parts that vanished are marked `removed`.
- A spec file change (hash of the spec id's file) also marks the lines that cite it as `untested`.
- Limit: HTML only shows what a page shows in its first state. Dialogs, error states and states after actions are only seen by driving the page, so snapshots must include scripted states (open each dialog, trigger each error), and the code hash covers the rest.

## Gaps are fixed right away (owner decision, 2026-10-25)

Spec-versus-code gaps are not just listed; they are part of the flow and get fixed in the same round.
- Spec states a clear rule and code breaks it: fix the code, test first.
- Code is clearly intended and spec is stale: fix the spec text and say so in the commit.
- Product choices (two reasonable behaviors): the fixer decides alone (owner decision 2026-10-25): best for the product as a career portfolio showcase, no over-engineering; use a pattern from `docs/work/architecture/pattern-map.md` where it genuinely fits, otherwise what fits the code, architecture and product. The reason goes in the commit message. No owner questions, no blocking.
- One commit per fix on the local branch `qa/seller-dashboard` (worktree `../portfolio-sandbox-qa`), checked by `scripts/qa/guard-tests.sh`; never pushed. `prompts/fixer.md` is the instruction.
- After fixes, the touched map lines go back to `untested` and the tester re-checks them (a fix without a re-check does not count).

## Definition of done for an area

1. Every line of the map is `pass`, `bug`-then-fixed-and-rechecked, or `n/a` with a reason; no `untested`, no `blocked`.
2. Every fix has a permanent test in the normal suites (Playwright, Vitest/Jest, backend end-to-end).
3. A full new AI pass over the whole map finds nothing new.
4. The usual suites are green: backend end-to-end (`scripts/speedup/run-sharded.sh 8`), front-end Playwright (both projects), unit tests, lint and type check.

## Tracks, limits

All extra tracks (planted bugs, mutation, concurrency, isolation, prod build with monkey and fuzzer, accessibility and other browsers, human pass, code coverage, rule-based random tests, fresh-seed pass, security scanners) and the short list of things that keep the flow imperfect are in `TRACKS.md`.
