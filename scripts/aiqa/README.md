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
