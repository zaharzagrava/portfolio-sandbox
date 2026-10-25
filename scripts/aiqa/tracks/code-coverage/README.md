# Track "code-coverage": which code did nobody ever run?

Plain words: while testers and tests use the app, a recorder notes which functions ran. Afterwards you get the list of functions of the area that never ran. Example: the "restore product" button code exists but no test ever pressed it, so it becomes a new map line to test (or is marked `n/a` with a reason when nobody can reach it).

## What this finds that the other tracks miss

The map-driven testers and the spec tests only test what the map lists. This track finds what the map forgot: code that exists but is never executed. It answers "did we really test everything we built".

## Prerequisites

- Browser side: the dev stack that is already running (web :3000, API :8000); Chromium only; the dev server must still answer when the recording stops (it serves the source maps). Set `QA_COVERAGE=1` in the shell that runs the tests; without it the recorder does nothing.
- Server side: a SEPARATE stack started with coverage on (`QA_COVERAGE=1 WITH_WEB=1 scripts/qa/stack-up.sh`; `stack-up.sh` refuses while the normal dev stack runs, so stop that one first and never run both). Node writes its coverage files only when the process exits cleanly, so the stack must be stopped politely with `flush.sh`.
- Memory: V8 coverage makes the Node processes slower and larger (plan for +30 percent); one stack only.

## How to point it at a NEW feature

1. The area name is the name of its map: `scripts/aiqa/coverage/<area>.tsv`. The scope of the report is built from the files named in the `code` column of that map plus the folders named after the area. A new area therefore needs its map first (mapper step).
2. Add the new feature's folders to `webRoots` (and the backend list) in `report.mjs` when they are outside `components/seller`, `app/dashboard/seller`, `lib/seller`; or run with `--all-seller` to take the whole seller scope.
3. In the tests of the new feature call `startCoverage(page)` before the first `goto` and `stopCoverage(page, '<area>')` at the end (a `beforeEach`/`afterEach` pair), or just run the whole spec file with `QA_COVERAGE=1` after adding the pair to the shared fixture.

## Commands

```
QA_COVERAGE=1 npx playwright test tests/seller/<area>/ --project=desktop --workers=1 --output=/tmp/my-cov   # browser side
node scripts/aiqa/tracks/code-coverage/report.mjs <area>                                  # writes coverage/<area>.unexecuted.md
node scripts/aiqa/tracks/code-coverage/report.mjs <area> --v8dir <QA_DIR>/v8-web --v8dir <QA_DIR>/v8-api    # with the server side
node scripts/aiqa/tracks/code-coverage/report.mjs <area> --append-to-map                  # adds the proposed lines to the map (only when asked)
scripts/aiqa/tracks/code-coverage/flush.sh <QA_DIR>                                       # polite stop of the coverage stack
```

## How to read the results

`scripts/aiqa/coverage/<area>.unexecuted.md` has four parts: files never loaded, functions that never ran, files that could not be measured (server components in a browser-only recording), and the proposed map lines. Judge each: a real feature nobody tested (add a test), dead code (report it; `n/a` with the reason), or a framework wrapper (`n/a`).

## How results become map lines, findings and register entries

`--append-to-map` appends lines `<area>.coverage.<file>-<function>` with status `untested`, spec `none`. A tester then writes a spec test for the line (annotation `aiqa-lines`) and marks it. Dead code that should not exist is a finding in `findings/<area>-<n>.md` and a register entry.

## Known limits

- Server-side recording was checked on a tiny program and not yet on the real Next server and API (see the details below).
- Chromium only; unit tests (Vitest) are not counted.
- A function that ran once counts as covered; this track does not say whether the result was checked.

## Details (from the first version of this README)

## Track 8: code coverage of the real app

Plain words: while testers and the permanent specs use the app, record which pieces of code actually ran. Afterwards list the code of an area that **never ran**: each such piece is either a missing map line (something nobody checked) or code nobody can reach (say so with a justified `n/a`).

Unit tests (Vitest) are not counted. Only the real app counts.

### Files

- `cover.mjs`: the browser recorder. `startCoverage(page)` before `page.goto`, `stopCoverage(page, '<area>')` at the end. Writes `specs/.checkpoints/coverage/raw/web-<area>-<time>-<id>.json` (functions of the original source files, found through the source maps of the dev server). **A no-op unless `QA_COVERAGE=1`** (or `{ force: true }`), so specs that call it run unchanged in a normal run. Chromium only.
- `report.mjs <area> [--v8dir <folder>]... [--raw <folder>] [--append-to-map] [--all-seller]`: merges all recordings and writes `scripts/aiqa/coverage/<area>.unexecuted.md` (never-loaded files, functions that never ran, files that could not be measured, and the proposed map lines: id `<area>.coverage.<file>-<function>`, status `untested`, spec `none`). `--append-to-map` appends those lines to `coverage/<area>.tsv` (never done unless asked; ids already in the map are skipped).
- `flush.sh <QA_DIR>`: stops the coverage-enabled web server and API politely so Node writes its files.
- `lib.mjs`: the converter (V8 functions of a bundle -> functions of the source files, through `@jridgewell/trace-mapping`, which is in the pnpm store as a Jest dependency; no new package).

### 1. Browser side (works on the stack that is already running)

In a tester script or a Playwright spec:

```js
import { startCoverage, stopCoverage } from '../../scripts/aiqa/tracks/code-coverage/cover.mjs'; // adjust the path
await startCoverage(page);              // before the first goto
// ... the test ...
await stopCoverage(page, 'inventory');  // the dev server must still answer: it serves the source maps
```

Run with `QA_COVERAGE=1`. In a Playwright spec the pattern is a `beforeEach`/`afterEach` pair on the `page` fixture. Then `node scripts/aiqa/tracks/code-coverage/report.mjs inventory`.

This sees what runs **in the browser** (client components, `lib/` code used by them). A page or server component that only runs on the server is listed as "not measured" until you also record the server side (below).

### 2. Server side (a coverage-enabled stack)

The running stack is not touched. To start a stack that records:

```
QA_COVERAGE=1 WITH_WEB=1 scripts/qa/stack-up.sh      # off by default; the same stack otherwise
```

That sets `NODE_V8_COVERAGE=<QA_DIR>/v8-web` for the Next dev server and `<QA_DIR>/v8-api` for the API process. Node writes the files **when the process exits cleanly**, so at the end:

```
scripts/aiqa/tracks/code-coverage/flush.sh <QA_DIR>      # Ctrl-C to the servers, counts the files
node scripts/aiqa/tracks/code-coverage/report.mjs inventory --v8dir <QA_DIR>/v8-web --v8dir <QA_DIR>/v8-api
scripts/qa/stack-down.sh <QA_DIR>
```

Server-side files are attributed through the `.js.map` next to each compiled chunk (`.next/dev/server/chunks`, the API's `dist`). If the API is bundled without source maps its functions cannot be attributed to source files and the backend files stay "not measured".

### How it was verified (2026-10-25)

Browser side: end to end on the running dev stack (signed in as the seed seller, opened the shop picker and a shop; `entry` report: files partly run / never loaded / not measured, and proposed lines). Server side: converter checked on a tiny TypeScript program run under `NODE_V8_COVERAGE` (executed and never-called functions told apart, mapped to the right source lines); the Next server and the API were **not** run with coverage because that needs a new stack (`stack-up.sh` refuses while the dev stack runs). Do that run once to confirm the server side on real chunks.
