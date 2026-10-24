# The seller QA runner, in plain words (2026-10-24)

## What was added
- `scripts/qa/seller-run.sh`: starts the ten seller charters, one after another or up to three at once, each with an explorer agent and then a fixer agent.
- `scripts/qa/guard-tests.sh`: looks at one commit and says "fine" or "rejected, because ...".
- `scripts/qa/test_seller_run.py`: 22 small checks of both scripts with pretend agents and a pretend web check. No real agent, server or docker is started. Run it with `python3 scripts/qa/test_seller_run.py`.
- `scripts/qa/stack-up.sh`: now checks the video side (see below).

## The video worker: nothing to start, one thing to have
The plan said the stack-up did not start a video worker. In fact the API that stack-up starts (`local-monolith`) already contains the worker app, and that app reads the video queue (`video-transcode`). So no extra process is needed.
What videos do need is the programs `ffmpeg` and `ffprobe` on this computer (they are installed here). Stack-up now prints a loud warning (and writes it to `warnings.log` in the stack folder) if one is missing, or if the API log never mentions video. It does not stop the stack. Photos and documents still use the small local stand-in (`start:lambda-local`), as before. The import worker is part of the same app, so it needs nothing extra either (not checked more deeply).

## How a run goes
1. It checks that the web page (3000) and the API (8000) answer. If not, it stops and tells you to start the stack.
2. It makes the branch `qa/seller-dashboard` in its own folder next to the repo (`<repo>-qa`), starting from `master`. It refuses to go on if that folder has unsaved changes. It never pushes, never switches your folder's branch, never writes on `master`.
3. Order: eight charters together (up to `QA_PARALLEL`, default 3, never more than 3), then `seller-orders` alone, then `seller-overview-live` alone.
4. Each charter: the explorer runs `scripts/qa/run.sh` with the charter's `minutes:` as its time box and a hard stop at minutes + 8. All its output goes to `specs/.checkpoints/qa-seller/<charter>.log`. If it leaves no report, it is run again (`QA_RETRIES`, default 1) after 30 seconds with the remaining time. After that the row says `crashed` and the run moves on. If the stack no longer answers, the whole run stops.
5. If the explorer confirmed defects, a fixer agent works in the branch folder and makes one commit per fix. Fixers go strictly one at a time (a lock), even when explorers run together.
6. After the fixer, every new commit goes through the guard. A bad one is undone with `git revert` on the branch (the history keeps both). Anything the agent left uncommitted is thrown away, inside the branch folder only.
7. The total time is `QA_BUDGET_MIN` (default 240 minutes). No charter starts when under 5 minutes are left, no fixer under 10, and agents still running are stopped at the end of the budget.
8. A desktop/phone message (the `notify` helper, set `NTFY_TOPIC` for the phone) goes out when a charter ends, fails, and when the budget runs out.

## Where to look
- `specs/.checkpoints/qa-seller/results.tsv`: charter, start, end, status, confirmed defects, fix commits kept.
- `specs/.checkpoints/qa-seller/changes.md`: one entry per commit: what, why, which test, which files; rejected ones marked REVERTED with the guard's reason.
- `specs/.checkpoints/qa-seller/<charter>.log` and `reports/` (the explorers' reports).
- The branch itself: `git log master..qa/seller-dashboard` in the branch folder.

## What the guard rejects
A commit that: removes a test title or `expect(` lines; adds `.skip`, `.fixme`, `.todo`, `xit`; adds `retries`; raises a timeout or a "less than" limit, or lowers a "greater than" limit, in a test; touches a Playwright, Vitest or Jest settings file; or is over 150 changed lines or 5 files (limits can be changed with `GUARD_MAX_LINES` and `GUARD_MAX_FILES`). Example: a fixer changes `toBeLessThan(100)` to `toBeLessThan(5000)` to get green: rejected and reverted.
The old `scripts/sdd/check-tests.py integrity` was not reused: it compares the working folder with HEAD, but here the question is about one finished commit.

## Things to know
- Checks are text-based, so a clever change (moving a check into a helper) can slip past. The final human read of `changes.md` still matters.
- The web app and API should be started from the branch folder if you want the fixes to show in the browser; the explorers use whatever is on ports 3000 and 8000.
- The fixer prompt and tool list are in the script (`default_fixer`); it can use `pnpm` and `npx` but not `git push`, `git reset` or branch changes (asked in the prompt; the tool list does not allow them).
- Nothing was run against real agents. First real run: `scripts/qa/seller-run.sh --only photos --no-fix --parallel 1` is a gentle start.
- The `--max-fixes` idea from the plan is a limit on branch commits (`QA_MAX_FIXES`, default 15).
