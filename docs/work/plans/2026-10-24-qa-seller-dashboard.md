# QA agents on the seller dashboard (plan, 2026-10-24)

Status: plan only. Nothing here has been run. The charters are written (`scripts/qa/charters/seller-*.md`); the runner script is only proposed below.

## What this is for

A test of one question: can AI deliver a fully working piece of the product on its own? The piece is the seller dashboard, because it is
big enough to be real (shop, products, photos, video, stock, import, orders, team, API keys, webhooks, numbers) and small enough to finish.

Agents use the dashboard in a real browser like a seller would, find bugs and holes, write tests that fail because of the bug, fix the
product, and show the tests now pass. The owner then looks at one git branch and one log and judges the result.

## The ten charters

A charter is a short brief for one agent: what to try, odd cases, what must be true (numbers like R-05 and B-12 point at the living
spec pages in `docs/spec/capabilities`), and a time box (`minutes:` at the top). Files in `scripts/qa/charters/`:

| charter | area | minutes |
|---|---|---|
| seller-shop-setup | open a shop, handle rules, picker and switcher, suspended shop, phone width | 15 |
| seller-products | inventory list, paging, search, add and edit, prices, version conflicts, archive | 20 |
| seller-photos | photo upload and gallery, with the known bug (below) | 20 |
| seller-video | video upload in parts, processing, resume, delete, private videos | 15 |
| seller-inventory-stock | stock numbers, low/out of stock, races with a buyer | 15 |
| seller-bulk-import | CSV and JSON-lines import, bad rows, error report, limits, cancel | 20 |
| seller-orders | orders, payouts, statements, exports (no buyer identity on screen) | 15 |
| seller-team | invitations, roles, last owner, what each role can reach | 20 |
| seller-developers | API keys, secret handling, webhooks, API version, logs, usage | 20 |
| seller-overview-live | the overview numbers checked against the database, the live panel | 15 |

Live streams: there is no seller page for live streams today. The seller dashboard has a live panel (live sales numbers), which
`seller-overview-live` covers. The live-stream viewer side (S23) is a different slice; leave it out of this test.

Total: about 175 minutes of agent time if run one after another, about 65 to 80 with three at once.

### The known photo bug

From `docs/work/2026-10-20-whats-left-hanging.md` section 8: after a photo upload the photo is "not properly loaded", disappears on reload,
and "Save photos" does nothing. The scripted test passes, so the gap is between the script and a real session. The charter makes the
agent walk the whole chain and name the first step that goes wrong. Likely places, written into the charter as things to check: the
browser cannot send the file to the storage address (blocked by the page's security rules or missing permission on the storage),
the photo worker is not running so the photo never gets ready, the picture address is on a host the web app does not allow, or the
"Save photos" button stays disabled because the page thinks nothing changed. None of these is confirmed.

## How a run works

Two kinds of agent, one after the other, so the explorer never changes anything and the fixer never guesses:

1. **Explorer** (already exists: `scripts/qa/run.sh`). Reads the charter and the spec pages, uses the dashboard, writes a report with
   DEFECT blocks and the Playwright scripts it used. Allowed: browser, curl, read-only database, log and queue reading. Not allowed:
   editing the repository.
2. **Checker** (already exists: `verify.sh`). A second, doubtful agent tries to reproduce each CONFIRMED defect and compares it with
   the spec. Verdicts: reproduced, gap (not built yet), not a defect, not reproduced. Only "reproduced" goes on.
3. **Fixer** (new). For each reproduced defect it: writes the failing test first (a Playwright test in `packages/web/tests`, or a
   backend end-to-end test in `packages/backend`, whichever sees the bug at the lowest level), runs it to see it fail, fixes the
   product, runs it to see it pass, runs the neighbouring tests (the other `seller-*.spec.ts`, the unit tests of the touched folder, and
   the backend suites of the touched domain), then commits.
4. **Gap finder** (new, small). After the explorer, it lists behaviors in the spec (B-nn, R-nn) that no test proves (the spec marks
   them `[proof: none]`) and that the explorer saw working, and writes a passing test for them. These tests are kept only if they pass
   now and fail when the behavior is broken on purpose (the repo already has `scripts/qa/mutations` for that idea).

The fixer is a separate step because fixing is where an agent is most tempted to cheat; it has its own rules below.

## The stack the run needs

- Docker running, and the developer's own dev stack stopped (the QA stack uses the same ports and container names). `scripts/qa/stack-up.sh`
  refuses otherwise.
- `WITH_WEB=1 scripts/qa/stack-up.sh`: a fresh database, queues, search and storage, the API, the two local stand-ins for the cloud
  workers (document check, and photo processing), seed data, and the web app on port 3000. About 4 minutes.
- **Video processing**: stack-up does not start a video worker. The video charter will fail at "stays PROCESSING forever" unless a
  video worker is started too. First job of the build step: add the video worker to the `start:lambda-local` line in `stack-up.sh`
  (or tell the agent clearly, the charter already says "if the worker is not running, say so first"). Same check for the import worker.
- `scripts/infra/doctor-live.sh` must be clean before the first charter.

### One stack for all agents, or one per agent?

Proposal: **one shared stack, but one fresh shop and one fresh account per charter**. Reasons: a full stack takes about 4 minutes and
about 5 GB of memory; three at once will not fit on the laptop. Charters mostly touch their own shop, so they do not disturb each other.
The risks of sharing: the photo and video limits are per shop (so fine), but the rate limits are per user and per address (all agents
share one address, so a busy charter can make another one see 429). Mitigation: each charter registers its own users, and the runner
runs at most 3 at a time. If the owner sees confusing 429s in the results, drop to 2 at a time or lift the address limits in the dev
environment file. Two charters must not run together: `seller-overview-live` (counts today's numbers; it creates its own shops, so it is
safe, but leaderboard rank depends on other shops) and `seller-orders` (leaderboards and rank); run these two alone, last.

An isolated stack per agent is the clean answer but is not affordable on this machine; revisit on the cloud runner.

### The seller account and the seed data

- `seller@marketplace.local` and `admin@marketplace.local`, password `Demo-Seed-Pw-7491!`, come from `pnpm --filter api seed:dev`.
  The seed also gives some products. Agents may use the seeded seller read-only, for looking.
- Each charter says to register its own accounts (buyer password `SuperSecurePassword123!`) and to open its own shop through the
  screen "Open your shop". That also tests shop setup for free. Products, orders and imports are made by the agent through the API.
- A shop is only fully "verified" after the document check stand-in has run; the prompt already handles this. If a charter needs a
  verified shop and has none, it says so and stops that part instead of guessing.
- Payment: the sandbox card (payment method id `pm_card_visa`).

## How findings are written

- Each explorer writes one report: `specs/.qa/<date>-<charter>.md` (existing shape: `DEFECT D1 CONFIRMED high: title`, steps, expected,
  actual, evidence). Its Playwright scripts go next to it.
- Every DEFECT line is also copied into `scripts/qa/findings.tsv` (existing), with the verdict from the checker. For this test the
  runner also keeps its own table `specs/.checkpoints/qa-seller/findings.tsv`: one row per defect with charter, id, severity, verdict,
  state (`found`, `test written`, `fixed`, `could not fix`, `skipped`), the commit, and the test file. That is the table the owner reads.
- SUSPICIOUS items are listed but never fixed by the agent. The owner decides.

## How fixes are made

- On its own branch, `qa/seller-dashboard`, made from the current `master`. The runner makes the branch if it does not exist and
  refuses to start if the working folder has uncommitted changes (the owner's edits must never be mixed in or lost). To avoid
  touching the owner's folder at all, the better way is a separate working copy: `git worktree add ../portfolio-sandbox-qa qa/seller-dashboard`.
  The stack and the web app then run from that copy.
- **Never push.** The runner has no push command in it, and the agent's allowed commands do not include `git push`. The owner reviews
  the branch and merges by hand. (The existing git guard hooks, `git-guardrails`, can be set up to block push, reset --hard and
  branch -D during the run.)
- **One commit per fix**, with a message that says: what was wrong, the charter and defect id, the test that proves it. Test and fix go
  in the same commit, so any fix can be reverted alone.
- **Never loosen a test.** The fixer may not: delete or skip a test, make an expectation weaker, raise a timeout to hide a slow
  step, add `retries`, change the test settings, or edit the spec text to match the bug. If an existing test seems wrong, it does not
  edit it: it writes the case in the log as "test seems wrong, owner decides" and moves on. The runner checks this mechanically after
  each fix: the diff may not remove any `expect(`, `it(`/`test(` line, add `.skip`/`.fixme`/`xit`, or touch config files
  (`playwright.config.ts`, `vitest*.config.ts`, `jest*.json`); if it does, the commit is undone and the defect is marked `skipped`.
- A fix must stay small: at most about 150 changed lines and 5 files. Bigger means "needs the owner", logged and left alone.
- Backend changes also need the touched domain's end-to-end tests to pass before the commit.
- **A log of every change with its reason**: `specs/.checkpoints/qa-seller/changes.md`, one entry per commit: time, defect id, files,
  one plain sentence "why", test name, result of the tests before and after. Plus the git history itself.

## What could go wrong

- **The agent invents defects.** Mitigation exists: the checker must reproduce it; known gaps are not defects; "no evidence, no defect".
- **The fix hides the bug instead of curing it** (for example makes the button appear but the data is still lost). The test must check
  the effect behind the screen (the database row or the API answer after a reload), not only the screen. The charters ask for that.
- **A fix breaks something else.** Neighbour tests run after each fix; a final full seller run (all `seller*.spec.ts` plus unit tests plus
  the backend suites of the touched domains) happens at the end and its result goes in the summary.
- **Tests that fail on a cold machine but pass warm** (the project already met this, see `fresh-run.sh`). The final check runs on a
  fresh stack.
- **Machine overload**: three agents plus the stack plus browsers. Memory and the web dev server's speed are the limit; start with 2.
- **The shared stack gets dirty** (many shops, hit rate limits, queues backed up). Mitigation: run doctor-live between charters and
  abort the run if it reports a parked outbox row or non-empty dead-letter queue that came before the run started (log it as stack trouble).
- **Cost and time**: each agent is a model session of up to its time box plus 5 minutes. Estimate 3 hours of agent time without fixes;
  fixes could double that. Set a hard total of 4 hours and a limit of 15 fixes.
- **An agent hangs or the model session dies.** The runner uses a time-out and a retry (below).
- **Photo bug cannot be reproduced by the explorer** because the headless browser does not behave like the owner's browser (different
  address for storage, different security rules). Then the report says what the chain looked like, and the owner is asked to run the
  same steps once by hand while watching the browser's network panel.
- **Secrets**: the explorer may see API keys it created; they live in the throwaway stack only. Reports must not contain real
  credentials; the seed password is already public in the repo.
- **Spec drift**: the living pages are a draft and some rules are marked `[proof: none]`. A mismatch between page and product can be a
  spec fault. The fixer may not edit the spec; it logs "spec and product disagree".

## Proposal: `scripts/qa/seller-run.sh` (not written yet)

Plain description of what it would do:

```
scripts/qa/seller-run.sh [--parallel N] [--only charter,charter] [--no-fix] [--max-fixes N] [--retries N]
```

1. **Check the stack.** Exits with a clear message unless web (3000) answers, `/health/ready` is ready, and `doctor-live.sh` is clean.
   The media workers (photo, video, import) must be running; check their log files. Offers the command to start the stack, does not
   start it itself (stack start is slow and the owner may want to see it).
2. **Check the folder.** Refuses to run with uncommitted changes in the folder it works in. Creates or switches to the branch
   `qa/seller-dashboard` (preferably in a separate worktree). Checks that `git push` is blocked (guard hook present).
3. **Make the list.** The ten `seller-*.md` charters, in a fixed order (stable ones first; `seller-orders` and `seller-overview-live`
   last, and alone). `--only` picks some.
4. **Run the explorers.** Up to N at a time (default 1, at most 3), each one through the existing `scripts/qa/run.sh <charter>` so the
   prompt, the tool limits and the time box (`minutes:` plus 5) stay as they are. Each has an outer time-out of minutes + 8 and its
   whole output goes to `specs/.checkpoints/qa-seller/<charter>.log`.
5. **Retry on a crash.** If the session exits with an error, or leaves no report, or runs out of time without a report: wait 30 seconds,
   check the stack with doctor-live, run it again with the time box shortened by what was used. At most 2 retries per charter
   (`--retries`). After that the row says `crashed` and the run goes on with the next charter. A stack that is no longer healthy
   stops the whole run (nothing is learnt by running into a broken stack).
6. **Verify and test** each CONFIRMED defect using the existing `verify.sh`, `dedupe.sh`, `regress.sh` steps (one at a time, because
   they run tests).
7. **Fix** (skipped with `--no-fix`): for each reproduced defect, up to `--max-fixes`, run the fixer agent with the rules above,
   then run the guards (no weakened test, small diff, neighbour tests green). On success make one commit on the branch; on failure
   restore the files (`git checkout -- .` restricted to the branch's worktree) and mark the defect `could not fix`.
   Fixes run strictly one after another, never in parallel, so two fixes cannot collide in the same files.
8. **Results table.** After every step it rewrites `specs/.checkpoints/qa-seller/findings.tsv`:
   `charter, defect id, severity, kind, verdict, state, commit, test file, minutes used`. At the end it prints a short table:
   per charter the number of defects found, reproduced, fixed, left, and the minutes used, then the list of commits.
9. **Final check.** The seller Playwright specs and seller unit tests, and the backend suites of the touched domains, once more;
   the result is the last line of the summary.
10. **Never** pushes, resets the owner's branch, deletes branches, or edits `master`.

Things to decide before writing it (questions for the owner):

- Worktree copy or the owner's folder for the branch? (Proposal: worktree.)
- Is it fine to add the video worker to the stack start script? (Needed for the video charter.)
- Fix limit and total time (proposal: 15 fixes, 4 hours).
- Do SUSPICIOUS items get fixed if the owner says so afterwards, in a second run? (Proposal: yes, by hand-picking ids.)

## How the owner judges the result

At the end there is: the branch with one commit per fix, the changes log, the results table, and the final test result. Success means:
the known photo bug is found and either fixed with a test that fails before and passes after, or explained to the point where the
owner can fix it; every charter ran or has a stated reason why not; no commit weakens a test; and the final seller test run is green on
a fresh stack. Not success: green tests achieved by removing checks.
