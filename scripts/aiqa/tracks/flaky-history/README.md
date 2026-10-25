# Track 14: flaky history

Plain words: every test run adds one line per test to a history file. A script then names the tests that sometimes fail and sometimes pass for the same code. Such a test is a bug to understand, never one to just retry.

Off by default: nothing is written unless `TEST_HISTORY=1`, and the reporters are not in any config, so normal runs do not change.

## Record

- Playwright (web): `TEST_HISTORY=1 pnpm exec playwright test <spec> --reporter=list,./tests/support/history-reporter.ts` (in `packages/web`). Every attempt (including a retry) is a line; `retries` is the attempt number.
- Vitest (backend e2e): `TEST_HISTORY=1 pnpm exec vitest run --config vitest.e2e.config.ts --reporter=default --reporter=./test/history-reporter.ts <file>` (in `packages/backend`; same flag works for any Vitest project).

File: `specs/.checkpoints/test-history.jsonl` (ignored by git through `specs/.checkpoints/*.jsonl`); `TEST_HISTORY_OUT=<path>` overrides it. One JSON line: `suite, run, name, file, project, result, duration, retries, commit, date`. A "run" is one invocation of the runner.

## Read

`node scripts/aiqa/flaky.mjs [file] [--runs=20]` lists tests that (a) both failed and passed on the same commit (a failure followed by a pass on a retry counts), or (b) failed in more than one of their last 20 runs. Exit code 1 when the list is not empty. Without history it says so and exits 0.
