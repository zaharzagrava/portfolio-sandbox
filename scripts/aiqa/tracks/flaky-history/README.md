# Track "flaky-history": which tests sometimes fail for no reason?

Plain words: every run of the tests adds one line per test to a history file. A script then names tests that failed and passed on the SAME code, or failed more than once in their last 20 runs. Example: `inventory edit` fails on Tuesday and passes on Wednesday with no code change. That test (or the app) has a hidden timing bug; fix it, never just retry it.

## What this finds that the other tracks miss

Hidden race conditions and timing bugs. A single green run proves nothing about them; only many runs do. It also shows whether a "flaky" test is really a product bug (a double-click, a slow response).

## Prerequisites

- No stack of its own. It rides on any normal test run. Set `TEST_HISTORY=1` and add the reporter. History file: `specs/.checkpoints/test-history.jsonl` (ignored by git); `TEST_HISTORY_OUT=<path>` moves it.
- Reporters: `packages/web/tests/support/history-reporter.ts` (Playwright) and `packages/backend/test/history-reporter.ts` (Vitest).
- Needs several runs to say anything (at least 3 to 5 on the same area).

## How to point it at a NEW feature

Nothing to edit: every test that runs with the flag is recorded, by name and file. Run the new spec files a few times with the flag, then read the list.

## Commands

```
cd packages/web
TEST_HISTORY=1 pnpm exec playwright test tests/seller/<area>/<new-spec>.spec.ts --reporter=list,./tests/support/history-reporter.ts --output=/tmp/my-flaky
cd ../backend
TEST_HISTORY=1 pnpm exec vitest run --config vitest.e2e.config.ts --reporter=default --reporter=./test/history-reporter.ts <file>
node scripts/aiqa/flaky.mjs [history-file] [--runs=20]
```

## How to read the results

`flaky.mjs` prints tests that (a) both failed and passed on the same commit (a retry that passes counts), or (b) failed in more than one of their last 20 runs, with counts. Exit code 1 when the list is not empty. Without a history it says so and exits 0.

## How results become map lines, findings and register entries

A test on the list is a finding: write it in `findings/` (what timing the test depends on, how to reproduce with `--repeat-each=20`), and add a register entry. The map line(s) named in the test's `aiqa-lines` annotation go back to `untested` until the cause is fixed (`mark.mjs <area> <line> blocked ...`).

## Known limits

- One history file per checkout; runs on different machines are not merged.
- It does not tell the cause; use `--repeat-each` and traces for that.

## Details (from the first version of this README)

## Track 14: flaky history

Plain words: every test run adds one line per test to a history file. A script then names the tests that sometimes fail and sometimes pass for the same code. Such a test is a bug to understand, never one to just retry.

Off by default: nothing is written unless `TEST_HISTORY=1`, and the reporters are not in any config, so normal runs do not change.

### Record

- Playwright (web): `TEST_HISTORY=1 pnpm exec playwright test <spec> --reporter=list,./tests/support/history-reporter.ts` (in `packages/web`). Every attempt (including a retry) is a line; `retries` is the attempt number.
- Vitest (backend e2e): `TEST_HISTORY=1 pnpm exec vitest run --config vitest.e2e.config.ts --reporter=default --reporter=./test/history-reporter.ts <file>` (in `packages/backend`; same flag works for any Vitest project).

File: `specs/.checkpoints/test-history.jsonl` (ignored by git through `specs/.checkpoints/*.jsonl`); `TEST_HISTORY_OUT=<path>` overrides it. One JSON line: `suite, run, name, file, project, result, duration, retries, commit, date`. A "run" is one invocation of the runner.

### Read

`node scripts/aiqa/flaky.mjs [file] [--runs=20]` lists tests that (a) both failed and passed on the same commit (a failure followed by a pass on a retry counts), or (b) failed in more than one of their last 20 runs. Exit code 1 when the list is not empty. Without history it says so and exits 0.
