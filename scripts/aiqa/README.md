# AI QA: test a whole slice of the app, with a map of what was checked

Goal: find out if an AI can FULLY test a given set of pages on its own, and know exactly what it did and did not check.

## The idea in plain words

1. A **map** lists every single thing a person can do on the pages in scope: every button, toggle, field, link, menu entry, dialog, every flow, and every rule the spec states. One line per item.
2. Each line says: which spec rule covers it, which code file builds it, and the status: not tested / passed / bug found / blocked, with the date, who checked, and the bug numbers.
3. Testers go through the map until no line is "not tested". For each line they check ALL layers: what the screen shows, what the server answers, and what is in the database.
4. The spec is the starting list, but the spec can be behind the code (or the code behind the spec). So the mapper also reads the code and lists the differences. Things in code but not in spec get lines too, marked `code-only`. Things in spec but missing in code are bugs.
5. Every bug goes to `docs/work/qa-bug-register.md`; counts go to `docs/work/qa-bug-scoreboard.md`.

## Where things are

- `coverage/<area>.tsv`: the maps (tab-separated, one line per item). Columns: id, what, spec, code, layers, status, date, by, bugs, note. Besides the four page areas there are two track maps in the same format: `odd-data.tsv` (one line per data shape x page, ids `odd-data.<area>.<shape>`) and `fault-injection.tsv` (one line per outage x action, ids `fault.<dependency>.<action>`).
- `tracks/<name>/README.md`: one plain-language README per extra track (see `TRACKS.md` for the table of maps, tests and commands).
- `packages/web/tests/seller/**/*.spec.ts`: the permanent tests; one test per behaviour, line ids in the title and in the `aiqa-lines` annotation.
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

## Cache (re-test only what changed)

Nothing that was checked and has not changed is tested again. Two kinds of change are watched.

**Code and spec (`fingerprint.mjs`, `recheck.mjs`).** A line is re-checked only when something it depends on changed, all the way down. Each map line gets a fingerprint: a hash of the content of
- every file named in its `code` column (paths like `a/b.ts#symbol`, `>` traces, short names such as `shop-picker.tsx`, globs; unknown paths are listed, never a crash);
- the definition file of every named class, function, hook or constant (`ShopController`, `ShopService.mine`, `useShop`, `pageForShop`: found in the web, backend and contracts sources; a name that is defined in more than 3 places is skipped);
- every named database table: the Sequelize model file with that `tableName` and every migration (`packages/backend/migrations*`) that creates or alters the table (`createTable`, `addColumn`, `ALTER TABLE ...`); a migration that only mentions the table in a foreign key does not count;
- the API client and the shared contracts of those files: `packages/web/lib/api/*` and `*.dto.ts` files they import, and the contracts (zod schemas, types) they import by name from `@marketplace-sandbox/contracts`;
- the spec lines that mention each id in the `spec` column (for example the line `- **W04.R-02** ...`; when no line carries the id, or the id is only a capability like `W04`, the whole capability file).
Fingerprints live in `coverage/<area>.fingerprints.json` (per line: `code`, `spec`, `at`, and the hash of every single file, so the note says which file changed). Limit: a changed file counts as a change even if the edit is a comment; the model file is hashed whole, not per column.
- `node scripts/aiqa/fingerprint.mjs <area>|all [--force]` stores fingerprints. Lines already `pass`/`bug` keep their old fingerprint unless `--force`, so a change since the check is not hidden.
- `node scripts/aiqa/mark.mjs ...` records the line's current fingerprint by itself whenever a tester marks `pass` or `bug`. Testers do nothing extra.
- `node scripts/aiqa/recheck.mjs <area>|all [--dry]` compares stored and current fingerprints. A `pass`/`bug` line whose hash changed goes back to `untested` with the note `changed: <files or spec ids>`; unchanged lines are never touched. `--dry` only prints.
- `node scripts/aiqa/run-specs.mjs <area> [--all] [--dry]` runs the permanent specs `packages/web/tests/seller/**/*.spec.ts`. A test names the lines it covers with `test.info().annotations.push({ type: 'aiqa-lines', description: 'id1,id2' })` (or a small helper `lines('id1','id2')` doing the same). The static read that decides which spec files to run takes every known line id of the area written anywhere in a spec file, so helpers and tables of ids work. First the stale lines go back to untested (recheck), then only the spec files that annotate an `untested` or `blocked` line of the area run (`--all`: every spec of the area). From the JSON result each line is marked by `mark.mjs`: all its tests passed -> `pass` (fingerprint stored), a test failed -> `bug` with bug id `spec-fail` and the first error line, only skipped -> left alone. So a passing line with an unchanged fingerprint is never run and no agent has to look at it again. `--dry` prints what would run.
- `node scripts/aiqa/status.mjs` ends with `stale: N lines changed since last check`.

**Pages (`snapshot.mjs`, `snapshot-diff.mjs`).** The demo seed is fixed (seller@marketplace.local, Demo Shop). `snapshots.config.json` lists, per area, the page states (url template with `{shopId}` and `{productId}`, steps that open a dialog or menu, roles `owner`, `viewer`, `noshop`, `anon`, widths). The scripts need the dev stack (web :3000, API :8000) and use Playwright from `packages/web`.
- `node scripts/aiqa/snapshot.mjs <area>|all [state]` opens every state at 1280 and 390 px for each role and stores `coverage/snapshots/<area>/<state>.json`: the page cut into parts (landmarks, headings, dialogs and menus, every button, link and form control) with a hash per part. Before hashing, ids, dates, times, "5 minutes ago", uuids, random strings, hashed class names and the unread counter are removed.
- `node scripts/aiqa/snapshot-diff.mjs <area>|all [--dry] [state]` takes the pictures again and prints added, removed and changed parts. A changed part is matched to map lines of the area by its text (role, label, aria-label) found in the line's `what`; the matching lines that were `pass`/`bug` go back to `untested` (note `ui changed: ...`). A label that matches more than 12 lines is printed as "too generic" and maps nothing. A new button or field that matches no line is printed as `new control not in the map`: add it to the map. The new picture replaces the stored one (not with `--dry`).
- Roles: `owner` (demo shop), `anon`, `noshop` (a member with no shop), and `viewer`, `staff`, `admin`. The last three are members of a throwaway shop "AIQA Roles Shop" owned by the helper seller `aiqa-owner@example.com` (one product), made on the first run and found again later; nobody is added to the demo shop. Each member is invited through the API, the invitation link is read from the dev mailbox (`GET /api/dev/mailbox?to=<email>`, the API keeps the last 50 mails in memory, see `findings/invite-mail.md`) and accepted with `POST /api/shop-invites/accept`. The helper accounts are `aiqa-<role>@example.com`. `snapshot.mjs ... --roles=viewer,staff,admin` takes only those variants and keeps the others in the file.
- Limit: a snapshot only shows what the steps in the config reach. Error states and states after an action need a config state with steps (or the code hash covers them). Data that other tests change (a new order in the list) shows as a changed part; that is a reason to look, not a bug.

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

## Adding a new feature to the flow (checklist)

Use this when a new page or capability is added (example: a "Team" page). Do the steps in this order; each step names the file or tool.

1. **Mapper** (`prompts/mapper.md`): read page + spec + code and write `coverage/<area>.tsv` and `coverage/<area>.gaps.md` (one line per button, field, state, rule; id `<area>.<section>.<thing>`). Run `node scripts/aiqa/fingerprint.mjs <area>`.
2. **Owner** skims the map and the gaps; gaps are fixed with tests (see "Gaps are fixed right away").
3. **Testers** (`explore.sh <area>`, `prompts/tester.md`): one spec per group in `packages/web/tests/seller/<area>/<group>.spec.ts`, test titles with the line ids, annotation `aiqa-lines`; mark lines from results with `run-specs.mjs <area>` (never by hand). Findings go to `findings/<area>-<n>.md`, then the register.
4. **Tracks to run again for the new area** (each README says where to edit):
   - `odd-data`: add the new entity and its odd values to `tracks/odd-data/seed.mjs`, lines to `coverage/odd-data.tsv`, tests to `odd-data.spec.ts` (text in other scripts, long words, rounding money, currencies, time zones, volume).
   - `fault-injection`: add the new actions to `fault-injection.spec.ts` (`LINE_IDS`, one "during" and one "after recovery" test each), lines to `coverage/fault-injection.tsv` for every dependency, and any new container to `CONTAINERS` in `tracks/fault-injection/run.mjs`; tell other testers, then `run.mjs --mark`.
   - `seller-isolation`: seller A must not read or change seller B's data on every new endpoint (own-shop ids, foreign ids, foreign cursors): add to `packages/web/tests/seller/cross-cutting/isolation.spec.ts` and the backend `*-isolation.e2e-spec.ts` files.
   - `concurrency`: double click, two tabs, parallel requests on every new write; database check for impossible rows: add to `packages/web/tests/seller/cross-cutting/concurrency.spec.ts` and the backend `*-concurrency.e2e-spec.ts` files.
   - `a11y-browsers`: add the page states to `tests/seller/cross-cutting/a11y.spec.ts` (and the Firefox file list in `playwright.config.ts`).
   - `security`: add the new folders to `WEB_DIRS`/`BACK_DIRS` and new routes to the Schemathesis path list in `tracks/security/run.sh`; a new rule needs a selftest sample.
   - `code-coverage`: record the new specs with `QA_COVERAGE=1`, `report.mjs <area>`, turn unexecuted code into map lines.
   - `mutation`: add the pure rule files (money, stock, permissions, paging) to `stryker.config.json` / `tracks/mutation/backend.sh`.
   - `stateful`: add properties for new pure functions and a command model for the new entity.
   - `prod-build`: add the pages to the monkey/fuzzer lists; `planted-bugs`: add one patch when you want the score to include the new area.
5. `node scripts/aiqa/status.mjs` must show no `untested`/`blocked` line for the area and no "pass without ui" problem; `node scripts/aiqa/recheck.mjs all` keeps the map honest after later code changes.

## Tracks, limits

All extra tracks (planted bugs, mutation, concurrency, isolation, prod build with monkey and fuzzer, accessibility and other browsers, human pass, code coverage, rule-based random tests, fresh-seed pass, security scanners) and the short list of things that keep the flow imperfect are in `TRACKS.md`.

## Invitation mail in the dev stack

Mails do not go to Mailpit: the dev API uses an in-memory mailbox, read at `GET http://localhost:8000/api/dev/mailbox?to=<email>` (the invite link is `/invites/<token>`; poll for a few seconds; it keeps the last 50 mails and is emptied on API restart). The API must be started with `pnpm --filter api run start:dev:monolith` (it sets `DEV_MAILBOX_ENABLED=true`). `readInviteLink` in `packages/web/tests/helpers.ts` does this. So the VIEWER and STAFF roles ARE testable: invite, read the link, accept. Details: `findings/invite-mail.md`.

## Real 429 rate limits in the dev stack

The API lets 127.0.0.1 through the limiter (`RATE_LIMIT_ALLOW_IPS`). To get a real 429, call the API through the machine's LAN address (for example `http://192.168.55.6:8000`, find it with `hostname -I`) instead of localhost; the limiter then counts and answers 429 with `Retry-After`. Use this for every line blocked on "no real 429". Do not change the allow-list.

## ONE SUITE rule (owner, 2026-10-25, said with anger, never violate)

There is exactly ONE front-end suite (`npx playwright test`) and ONE backend suite. AI QA does NOT make a second suite and does NOT pile new files on top of the existing tests.
- Before writing a test, search the existing suite for the same behaviour (`packages/web/tests/*.spec.ts`, `seller-*.spec.ts`, unit tests next to the code, backend e2e next to the code). If a test covers it: reuse it, extend it with the missing assertion, or fix it. Do not write a duplicate.
- New tests go INTO the existing feature file when one exists (for example `seller-inventory.spec.ts`), or into one new file per feature in the normal place. Never a folder of one-file-per-section specs. Target: a few files per feature, not 15.
- The whole suite must stay inside its time budget (front end about 9 to 10 minutes at 3 or 4 workers; backend about 12). A new test that does not fit the budget is merged, made cheaper, or run on desktop only. AI QA measures the suite time before and after every change and reports it.
- Cheap tests: log in by API, create the seller/shop once per file (beforeAll), no fixed sleeps, phone project only for specs about the phone layout, one desktop run for everything else.
- The map (`coverage/<area>.tsv`) records which existing or new test covers each line (the `aiqa-lines` annotation can be added to an existing test). The map is the sync between the AI QA flow and the suite; it is never a reason for a new file.
- Slow or special runs (container pausing, the 10,000-product seed, 12-minute auction, 49-minute photo purge) are not part of the normal run and are gated by an env switch.

Full binding rules for FE and BE (one suite, scenario ids in titles, performance budget): docs/work/architecture/test-suite-rules.md. The SDD flow (scripts/sdd) follows the same file.
