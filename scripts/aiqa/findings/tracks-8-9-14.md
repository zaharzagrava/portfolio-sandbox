# Findings of tracks 8, 9 and 14

Written 2026-10-25. Plain words: what the new tracks found as product problems.

## Track 9, pure web logic (ran: 23 rules, thousands of random inputs each)

No product bug found. Money parsing, stock status, filters and address building, permissions and `returnTo` all kept every rule. (Two first-draft failures were mistakes in the new test itself, fixed.)

## Track 9, product lifecycle against the real API (written, not run)

Nothing to report yet: the spec needs the backend test stack, which was not up. When it runs, any failure is a real finding unless it is one of the three assumptions listed in `tracks/stateful/README.md` (status codes of refused commands, field names of the member view). Keep the spec unskipped and add the bug here with steps (the shrunk command list fast-check prints), expected (spec id in the test title), actual and evidence.

## Track 14, flaky history

Nothing recorded yet: the history file fills as suites run with `TEST_HISTORY=1`. Seen while verifying the reporter: `tests/share-link.spec.ts` (both tests, desktop) failed on the live dev stack at `productId()` in `tests/helpers.ts:259` (before reaching the feature). Not investigated (outside these tracks, the dev stack is shared with other work); worth a look if it repeats.

## Track 8, code coverage

The first end-to-end run was a tiny one (sign in, shop picker, one shop page) and is not a finding. Real read-outs come from running the testers with `QA_COVERAGE=1` and then `report.mjs <area>`.
