# Track 8: code coverage of the real app

Plain words: while testers and the permanent specs use the app, record which pieces of code actually ran. Afterwards list the code of an area that **never ran**: each such piece is either a missing map line (something nobody checked) or code nobody can reach (say so with a justified `n/a`).

Unit tests (Vitest) are not counted. Only the real app counts.

## Files

- `cover.mjs`: the browser recorder. `startCoverage(page)` before `page.goto`, `stopCoverage(page, '<area>')` at the end. Writes `specs/.checkpoints/coverage/raw/web-<area>-<time>-<id>.json` (functions of the original source files, found through the source maps of the dev server). **A no-op unless `QA_COVERAGE=1`** (or `{ force: true }`), so specs that call it run unchanged in a normal run. Chromium only.
- `report.mjs <area> [--v8dir <folder>]... [--raw <folder>] [--append-to-map] [--all-seller]`: merges all recordings and writes `scripts/aiqa/coverage/<area>.unexecuted.md` (never-loaded files, functions that never ran, files that could not be measured, and the proposed map lines: id `<area>.coverage.<file>-<function>`, status `untested`, spec `none`). `--append-to-map` appends those lines to `coverage/<area>.tsv` (never done unless asked; ids already in the map are skipped).
- `flush.sh <QA_DIR>`: stops the coverage-enabled web server and API politely so Node writes its files.
- `lib.mjs`: the converter (V8 functions of a bundle -> functions of the source files, through `@jridgewell/trace-mapping`, which is in the pnpm store as a Jest dependency; no new package).

## 1. Browser side (works on the stack that is already running)

In a tester script or a Playwright spec:

```js
import { startCoverage, stopCoverage } from '../../scripts/aiqa/tracks/code-coverage/cover.mjs'; // adjust the path
await startCoverage(page);              // before the first goto
// ... the test ...
await stopCoverage(page, 'inventory');  // the dev server must still answer: it serves the source maps
```

Run with `QA_COVERAGE=1`. In a Playwright spec the pattern is a `beforeEach`/`afterEach` pair on the `page` fixture. Then `node scripts/aiqa/tracks/code-coverage/report.mjs inventory`.

This sees what runs **in the browser** (client components, `lib/` code used by them). A page or server component that only runs on the server is listed as "not measured" until you also record the server side (below).

## 2. Server side (a coverage-enabled stack)

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

## How it was verified (2026-10-25)

Browser side: end to end on the running dev stack (signed in as the seed seller, opened the shop picker and a shop; `entry` report: files partly run / never loaded / not measured, and proposed lines). Server side: converter checked on a tiny TypeScript program run under `NODE_V8_COVERAGE` (executed and never-called functions told apart, mapped to the right source lines); the Next server and the API were **not** run with coverage because that needs a new stack (`stack-up.sh` refuses while the dev stack runs). Do that run once to confirm the server side on real chunks.
