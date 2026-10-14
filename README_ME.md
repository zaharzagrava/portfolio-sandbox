# README_ME: full setup and developer guide

The short version for visitors is in [README.md](README.md). This file has everything else: the full local stack, ports, load tests, and the tooling I use to work on the repo.

Requirements: Node 24+, pnpm 12, Docker.

## The agentic delivery loop: what it is, how to set it up, how to run it every day

This is the one place that says how the whole machine fits together. Details of each part are in the sections further down and in
[`docs/work/architecture/sdd-runbook.md`](docs/work/architecture/sdd-runbook.md).

### What it is, in one picture

```
 idea ──► SPECS (67 capabilities: spec, plan, tasks, test plan, questions)         scripts/sdd/write-specs.sh
              │
              ▼
        BUILD LOOP (fresh-context Claude passes, one capability at a time)         scripts/sdd/implement-specs.sh
              │   each capability: plan → tasks → implement → GATE
              │   GATE = type check, lint, unit tests, database-backed e2e tests, scenario check, living-spec check
              │   gate fails → REPAIR AGENT (fresh context, ≤5 tries, shared 60 min budget) → gate again
              ▼
        CHECKPOINT (a regression sweep at a !STOP line of the order file)         scripts/sdd/checkpoint.sh
              │   all backend suites, the whole browser suite, living-spec checks,
              │   a scripted buy flow (buy-ui.sh), the live infrastructure doctor,
              │   optionally the QA PIPELINE:  find ─► verify ─► write a failing test
              │   checkpoint fails → CHECKPOINT REPAIR AGENT (≤5 tries) → checkpoint again
              ▼
        you: morning routine (below)  ◄── notifications to your phone (ntfy)

 around it:  living spec (what the system does today, checked against code and tests)    docs/spec, scripts/livespec
             lessons    (every failure → a rule the agents read + a check)                docs/lessons.md, scripts/lessons
             metrics    (one JSON line per step → a report with trends)                   .sdd-metrics, scripts/sdd/report.py
             decisions  (the defaults the agents chose, triaged to the few that are yours) docs/work/decisions, scripts/decisions
             QA agent   (an exploratory tester with a benchmark of known bugs)            scripts/qa
             mutation   (do the unit tests fail when the code is wrong?)                  scripts/mutation
```

Rules the machine keeps (so you can trust a morning result): agents never edit a `*.reviewed.json` (only you sign the living pages); a test is never
weakened to make a gate pass; a failure that goes away with unchanged code is recorded as a flake, not as a fix; nothing is pushed to `master` by the runner
(it pushes `sdd/auto`, a safety snapshot on `sdd/wip`, logs on `sdd/logs`).

### The map: every script, every agent, who starts whom (read this first after a long break)

There are only two kinds of things in this machine, and mixing them up is what makes it feel complicated.

- **Scripts** (bash and Python) are the managers. They are dumb and predictable: they decide what runs next, run the tests, count attempts, watch the clock, and send you phone messages. They never write product code.
- **Agents** are fresh Claude sessions (`claude -p ...`, started through `run_claude` in `scripts/sdd/lib.sh`). An agent has no memory of any earlier agent: it gets a prompt, a small set of allowed tools, does one job, and ends with one line that a script can read. Every "retry" is a NEW agent that reads the failure from a file, never a continuation.

A script starts an agent; an agent never starts another agent. So you can always read the picture as a tree: a script on top, agents at the leaves.

#### The agents (11 jobs, each is a fresh session)

Builders (they write the product):
1. **Spec writer** - `scripts/sdd/write-specs.sh`. One session per capability, command `/speckit-specify`. Writes `spec.md`, plan, tasks, test plan and `questions.md` into `specs/<domain>/<id>-<slug>/`. Runs once per project, 13 to 17 hours for 67 capabilities, resumable.
2. **Builder passes** - `scripts/sdd/implement-specs.sh`. For each capability, in this order: `plan`, `tasks`, `analyze`, then `implement-1`, `implement-2`, ... (each pass is a fresh session; a big spec does not fit into one) and `converge` when the passes added tasks. Ends when `tasks.md` has no open checkbox (at most `MAX_IMPLEMENT_PASSES`, 10).
3. **Gate repair agent** - same script, steps named `repair-1` to `repair-5`. Started when the gate (types, lint, unit tests, e2e tests, scenario check, living-spec check) fails. It gets the gate log and fixes the code. At most `MAX_GATE_REPAIRS` (5) tries.
4. **Doctor** (capability repair agent) - same script, steps `doctor-1` to `doctor-3`. The bigger hammer: started when a capability still fails after its gate repairs are used up, or its tasks stay open after the last builder pass (the capability step ends with exit 20). It decides what is wrong and either fixes it (the capability is retried) or ends with `DOCTOR: needs human: <why>`. At most `MAX_REPAIRS_PER_SPEC` (3) tries per capability, at most 25 minutes each, and all repair agents of a run share `REPAIR_BUDGET_MIN` (60 minutes). If the doctor gives up or the time is gone, the capability is written to `BLOCKED.md` in its spec folder and the loop moves on to the next capability that does not depend on it.
5. **Checkpoint repair agent** - `scripts/sdd/checkpoint-repair.sh`, steps `ckrepair-<label>-1` and up. Started when a checkpoint (the big regression run) fails. It gets the failing tests, the page snapshots Playwright saved and the log. It decides first whether the environment or the code is at fault; a failing test in `packages/web/tests/qa/` means the product is wrong (the QA chain wrote it). At most `MAX_CHECKPOINT_REPAIRS` (= 5) tries inside the shared 60 minutes. It ends with `CHECKPOINT-REPAIR: fixed`, `flake` (the failure did not come back and it changed nothing) or `needs human`.

Documenters (they write words, never product code):
6. **Living page writer** - `scripts/livespec/generate.py`, run by the build loop after a capability passes its gate. One session with no tools, fed only facts extracted by the script, writes the first draft of `docs/spec/capabilities/<id>-*.md`. You review and sign it later (`reviewed.json`, a human-only action).
7. **Decision triage** - `scripts/decisions/triage.py generate <id>`, also run after a capability is built. Reads the dozens of defaults the builders recorded in `questions.md` and writes at most 8, ranked, into `docs/work/decisions/<id>.md`. Your answers (`change: ...`) are given to the next builder pass.

Spec vocabulary (every word of a rule is defined once; `scripts/livespec/terms.py`, details in `docs/spec/README.md`):
- **Term finder** (`terms.py expand <page>`): reads the rules in chunks and lists the phrases a junior engineer would have to guess. Two kinds: a word of THIS system (or an everyday word with a special meaning here: "section", "errors entry") gets its own page in `docs/spec/terms/`; a general software word (HttpOnly, CSRF, JWT) gets NO page: it is linked, with an arrow, to the one glossary `docs/spec/sw-external-terms.md`, which only points at an authoritative reference (MDN, an RFC, OWASP) that the script opened and checked.
- **Term writer** (same command): writes the pages of the new terms (Definition, Example, Known gaps), six per call, then reads each new definition the same way, recursively, until nothing new comes up. The model never rewrites a rule: the script inserts the links.
- **Consolidator** (`terms.py consolidate [--apply]`): merges pages that are the same concept under two names, and drops single-use pages that only restate their rule.
- **Cycle breaker** (`terms.py break-cycles`): definitions may not be circular (links inside a Definition form a directed acyclic graph; "Used by", Example and Known gaps may point anywhere). A fundamental term that leaned on a peripheral one is rewritten in plain words.
- The levers (granularity, how eagerly pages are merged or inlined, models, speed, limits) are in `scripts/livespec/terms.config.json`; tell me which one to turn, or edit it and run the command named in `docs/spec/README.md`, "Levers".
- Regenerate one term in about half a minute: `terms.py redo <slug> --note "what you dislike"`; one page: `terms.py expand <page> --fresh`; promote a concept that a second place needs: `terms.py promote`.
- Drift is checked mechanically by `python3 scripts/livespec/check.py` (a second): a rule that uses a term changed and the term was not read again (`terms.py accept <slug>` records that you did), a number in a definition that no rule states, a link to a missing page, a circular definition, a bare use of a distinctive term, an inline explanation that duplicates a term page. Limit: a term that only other terms use has no rule fingerprint, so a change deep in the graph is not detected.

The QA chain (it uses the finished product like a person and writes tests from what it finds):
8. **Explorer** - `scripts/qa/run.sh <charter>`. A session with a browser (Playwright) and curl, a time limit and a charter (a short briefing: what to try and break). Writes a report `specs/.qa/<date>-<charter>.md` with lines `DEFECT D1 CONFIRMED|SUSPICIOUS <severity>: <title>`, and the scripts it used next to it. It can never edit the repository.
9. **Skeptic** (verify) - `scripts/qa/verify.sh <report> <D-id>`. A second session that has NOT seen the first one. It follows only the written steps of one finding, twice, with a fresh account, checks the living spec ("Known gaps"?) and writes `VERDICT: reproduced | not-reproduced | gap | not-a-defect`. If it writes no verdict, it is asked once more.
10. **Test writer** - `scripts/qa/regress.sh <report> <D-id>`. A third session that turns a reproduced finding into `packages/web/tests/qa/<charter>-<stamp>-<id>.spec.ts` (the report's time stamp keeps two runs' `D1` apart). The pipeline then RUNS that test and keeps it only if it fails now (a test that passes does not prove the bug).
11. **Charter drafter** - `scripts/qa/make-charters.sh`. For a built capability that no charter covers, writes a draft charter (`status: draft`) from its living page, or answers that there is nothing a person could walk through (the id goes into `scripts/qa/charters/.no-flow`).

Not agents (plain scripts you should know by name):
- `scripts/sdd/checkpoint.sh` - the regression run; the only place the QA chain is called from the loop.
- `scripts/qa/pipeline.sh` - runs agents 8, 9, 10 in a row for the given charters.
- `scripts/qa/select.py` - picks which charters run (below).
- `scripts/sdd/checkpoints/<label>.sh` (for example `buy-ui.sh`) - a scripted walk of one flow through the API, no AI.
- `scripts/infra/doctor-live.sh` - looks for stuck payments, parked outbox rows, dead-letter queues.
- `scripts/qa/benchmark.sh` - the QA agent's exam (re-introduces known bugs, checks the agent finds them).
- `scripts/mutation/mutate.py` - mutation testing, run by hand.
- `scripts/vps/run-remote.sh` and `vm-run.sh` - start and run the cloud machine; the loop itself is the same `implement-specs.sh`.

#### What happens in one run, step by step (with the script that does each step)

1. You run `scripts/vps/run-remote.sh --image fe --hours 10` (laptop). It creates a Hetzner machine from a snapshot, the machine clones the repo from GitHub, starts the dev stack and API, and runs `implement-specs.sh` on the order file. You can close the laptop. The machine deletes itself at the end.
2. `implement-specs.sh` reads the order file (`scripts/sdd/orders/by-flow.txt`) and walks it line by line. A capability line means "build it". A `!STOP <label>` line means "checkpoint".
3. **Build a capability:** builder passes (agent 2) until the tasks are done, then the **gate**. Gate fails: gate repair agent (3), gate again, up to 5 times. Still failing: the capability fails hard, the **doctor** (4) tries, the capability is retried. Doctor gives up or the budget is gone: **BLOCKED**, next capability.
4. **Capability passed:** the living page is drafted (6), the decision list is written (7), the work is committed to `sdd/auto` (and logs to `sdd/logs`, a snapshot to `sdd/wip`), and your phone gets a message.
5. **Checkpoint line reached:** `checkpoint_with_repair` (in `checkpoint-repair.sh`) runs `checkpoint.sh`:
   1. all backend e2e suites, in batches of 12, each batch a fresh process;
   2. the whole browser suite (Playwright);
   3. the living-spec checks;
   4. the flow script `checkpoints/<label>.sh`, which includes the live doctor before and after;
   5. only when `CHECKPOINT_QA` is set: the QA chain (below).
6. **Checkpoint failed:** checkpoint repair agent (5), then the checkpoint runs again. Passed after a repair that changed no code: recorded as a **flake** (`specs/.checkpoints/<label>.flakes.md`) and listed in your phone message. Passed: a marker file is committed, so a fresh machine does not stop here again, and the run ends with a message.
7. **Morning:** you read the phone message, `git fetch && git checkout sdd/auto`, run `scripts/sdd/report.py`, read BLOCKED files, answer the top decisions in `docs/work/decisions`, sign living pages (details in "The morning routine").

#### The QA chain inside the checkpoint (step 5.5 above)

`CHECKPOINT_QA="buy account"` runs exactly those charters. `CHECKPOINT_QA=auto` is the selective mode and is the one to use:

1. `make-charters.sh` (agent 11): at most `MAX_NEW_CHARTERS` (2) drafts for built capabilities that no charter lists.
2. `select.py`: a charter is due when a commit touched the `scope:` paths of one of its capabilities after the charter's last report in `specs/.qa` (or it never ran and its capability is built). Most changed first, then the longest without a run, until `QA_BUDGET_MIN` (30; a charter counts its minutes plus 6). The first one is always taken. `select.py --explain` shows why each charter ran or was skipped.
3. `pipeline.sh <charters>`: for each charter run the explorer (8). The explorer is told what is already settled (`scripts/qa/tally.py known`: gap, false, noise, and real ones that have a test) and not to report it again. For each CONFIRMED defect, `scripts/qa/dedupe.sh` first asks a short session whether it is the same defect as a settled one (the explorer words the same bug differently every time, so word matching fails); if so it is marked `dup` in the ledger and goes no further, and it does not use up the fix quota. A match with a still-pending finding does not count: it must still be handled. Then, at most `MAX_QA_FIXES` (3) per checkpoint: skeptic (9). Only `reproduced` goes on: test writer (10), then the test is run; a passing test is thrown away, a failing test is kept.
   SUSPICIOUS findings are only ever written to the report and the ledger. Nobody acts on them automatically.
4. The ledger `scripts/qa/findings.tsv` gets every finding with its verdict (`pending`, `real`, `gap`, `false`, `noise`). You can overrule any verdict: `scripts/qa/tally.py set <stamp> <charter> <id> <verdict>`. `scripts/qa/tally.py` shows counts and precision; `report.py` shows the same.
5. If `pipeline.sh` left a failing test, the checkpoint FAILS, and the checkpoint repair agent (5) fixes the product until that test passes. That is the whole "find, verify, test, fix" loop. After a repair the QA agent does not run again in that checkpoint (marker `specs/.checkpoints/<label>.qa-done`); only the tests it left behind run again.

The full pass (every charter, hours) is not part of the loop: `scripts/qa/full.sh`, by hand, before a release.

#### Where to look when something went wrong

- Phone message first: it names the capability or checkpoint and what failed.
- One builder step: `specs/<domain>/<id>-<slug>/.<step>.log` (for example `.implement-2.log`, `.repair-1.log`, `.doctor-1.log`); the gate: `.gate.log` in the same folder; why it was blocked: `BLOCKED.md`.
- A checkpoint: `specs/.checkpoints/<label>.log`, the repair agent's log `specs/.checkpoints/.ckrepair-<label>-<n>.log`, flakes in `<label>.flakes.md`.
- The QA chain: reports and scripts in `specs/.qa/`, the skeptic's notes `<report>.verify-<D-id>.md`, the tests in `packages/web/tests/qa/`, the ledger `scripts/qa/findings.tsv`.
- Numbers over time: `.sdd-metrics` and `python3 scripts/sdd/report.py`.
- The cloud machine: branch `sdd/logs`, and `scripts/vps/README.md` for how to look at a running machine.

#### Words I will forget

- **Gate**: the checks one capability must pass before it counts as built.
- **Checkpoint**: the regression run at a `!STOP` line; every earlier capability must still work.
- **Charter**: a short briefing for the explorer (name, which capabilities, minutes, what to try). `scripts/qa/charters/*.md`.
- **Oracle**: how the explorer decides something is a bug. Generic (a 5xx, a console error, something pending more than 30 s, a parked outbox row, a dead-letter queue) beats the spec's rules, which beat its own opinion (those are only ever SUSPICIOUS).
- **Ledger**: the table of everything the QA agent ever reported and what turned out to be true.
- **Flake**: a failure that disappeared while the code stayed the same. Recorded, never counted as a fix.
- **Blocked**: the loop gave up on one capability (and everything that depends on it) and moved on.
- **Layer 1, 2, 3 of tests**: 1 = ordinary Jest and Playwright tests the builders write for every capability (this is where coverage comes from); 2 = "AI compiled once, self-healing scripts", which I decided not to build; 3 = the exploratory QA agent, which only looks for what nobody wrote a test for.

#### Why a capability gets blocked, and how the doctor, the stack and the lessons fit together

Written on 2026-10-14 after three runs in a row were blocked by the same kind of problem. Read it before you touch the lessons or the doctor.

**How a capability is built, and who is called when**
1. A fresh agent each for `plan`, `tasks`, `analyze` (once per capability), then `implement` passes (each one a fresh agent; it ticks tasks in `tasks.md`; up to 10 passes until none is open), then `converge`.
2. `converge` compares the spec, the plan, the tasks and the code and appends anything unbuilt as NEW tasks. It also reads the lessons digest. This is where unexpected tasks come from.
3. The gate (plain scripts, no model): scenario ids in tests, test integrity, living-spec check, lint, type check, the monolith boot check, then the capability's tests. Fails: the **gate repair agent** (up to 5 attempts, phone message "repair attempt N of 5").
4. The **doctor** is the second level and is called only when the capability is stuck (an implement pass closes no task, tasks stay open after the last pass, or the gate still fails after its repairs). It reads the log and answers `DOCTOR: fixed` (the capability is built again) or `DOCTOR: needs human: <why>`, and then the capability is BLOCKED (`BLOCKED.md` in its spec folder), skipped with everything that depends on it, and the loop goes on. At most 3 doctor attempts per capability, one shared repair budget of 60 minutes per run.
5. Gate passes: living page, term pages, decision list, commit, push. The checkpoint (now one, at the very end of the order file) runs the sweep, the flow scripts, the QA agent and the checkpoint repair agent.

**Why a task can demand a proof that cannot be given**
- Every agent reads a digest of `docs/lessons.md`. Lessons L-012 ("verify on a fresh stack"), L-015 and L-018 ("the real apps must boot on their own") are written as rules, so `converge` turns them into tasks such as "T061 HIGH: prove the real apps boot on an empty stack". Nobody asked for that in the spec; it is the lessons, applied literally.
- An unattended agent cannot approve anything. It may run only what is on the allow-list `IMPL_TOOLS` in `scripts/sdd/implement-specs.sh`. A task that needs a command that is not listed (starting a server, installing a package, a script) ends in "needs human". Every command a task may need must be listed, and have a script that does it.

**The stack, empty and warm**
- The dev stack (PostgreSQL, Redis, Kafka, Elasticsearch, ClickHouse, Scylla, the queue server, MinIO and the API) is created ONCE per run, when the machine boots. At that moment it is empty: new volumes, nothing in it. The test stack for the e2e suites is separate. Neither is recreated between capabilities.
- A **warm** stack is one that has been running and holds leftovers (products, orders, indexes, queue messages, caches) from earlier tests and agents. Leftovers can make a broken thing work. On 2026-10-12 a fix was debugged on a warm stack for hours while the cloud machine, which always starts empty, kept failing (L-012).
- On the runner the stack is empty only for the first minutes. After that no task can be satisfied by "run it on an empty stack": the stack cannot be emptied without destroying what the whole run uses (`fresh-run.sh` refuses next to it: same container names and ports). `scripts/qa/fresh-run.sh --here` judges the running stack instead (boot check, live doctor), and is chosen by itself on the runner.

**The rule that came out of it (L-019)**
- Runtime proofs (the real apps boot on their own, an empty-stack run, the browser suite) belong to the final checkpoint and are done by scripts (`scripts/sdd/checkpoints/final.sh`: `boot-app.sh core|projector|worker`, `fresh-run.sh --here`, the buy flow). A builder or converge pass must not add a task for them.
- A task that still asks for one is ticked with "deferred to the final checkpoint: <command>" and one line in `specs/deferred-checks.md`. The doctor is told to do exactly this and answer `DOCTOR: fixed` instead of blocking a capability whose code and tests are green.
- Tests may be replaced, split or deleted; a scenario may not disappear (L-017).

**What went wrong on 2026-10-13 and 14, in order, and what fixed each**
- API never ready at start (two modules wired wrongly, L-015): re-exports; `boot-check.sh` in the gate, the checkpoint and the runner.
- Every login a 500 on the local dev stack: a descending query on a DynamoDB index that Scylla 6.2 cannot answer (`ScanIndexForward: false`); read ascending and reversed.
- Loop ended with exit 123 after a gate finding (L-016): `code_fingerprint` crashed on a deleted file; also backticks in a prompt line ran as a command.
- "Test file deleted" false alarm and the wrong rule "never delete a test" (L-017): the guard follows scenario ids.
- S19 blocked: `fresh-run.sh` refuses next to the runner's own stack (`--here`), then the script was not on the allow-list (allow-list).
- Runner stuck in `playwright install chromium` (the CDN crawled): 150 s per attempt, three mirrors. Open: bake Chromium and ffmpeg into the image (needs the runner stopped: Hetzner's dedicated-core limit allows no second big machine).
- S30 blocked, no `ffmpeg` on the runner: installed at boot (and in the image build, next rebuild).
- S36, S39, S47 blocked, "boot the real apps": `boot-app.sh` and its allow-list entry; it found that `apps/projector` aborted at boot (fixed), `apps/payment-processor` does not boot (open), and the dev `.env` lacked five settings (fixed).
- API not ready at the next start: the `.env` baked into the image is old and the script left it alone; the runner now rewrites it every boot (`FORCE=1`), and a config error ends the wait at once with its cause.
- S36 and S47 blocked again on "prove it on an empty stack" tasks: L-019.

#### What is proven and what is not (updated at the end of the 2026-10-13 session)

- Proven by a real run: the builder loop and both gate levels (earlier runs, S01 to S51); the QA explorer finds all four re-introduced bugs (`groupId`, missing queue, silent consumer, missing search index); on a real product bug (search clicks answered 400) verify said `reproduced`, the test writer produced a test that failed, a repair agent fixed the endpoint and the test passed.
- Proven only in pieces: the chain was driven step by step by hand; the first run through `implement-specs.sh` -> `checkpoint.sh` -> `pipeline.sh` -> repair agent was started on 2026-10-13 (see "Where it stands").
- Not proven: any of it on the cloud machine; `CHECKPOINT_QA=auto` over a whole night; the other charters; how well deduplication holds over many nights (tested on one pair: the same search-click bug reported by two charters was matched, a different bug was not).

### One-time setup

1. Requirements on the laptop: Node 24+, pnpm 12, Docker, `claude` (Claude Code CLI), `hcloud` (Hetzner CLI), `jq`, Python 3, `gh` (optional).
2. `pnpm install`. Local stacks: `moon run infra-test-up` (test stack, e2e specs) and `moon run infra-setup` + `moon run dev-monolith` + `pnpm --filter web dev`
   (dev stack). Never start compose with `-d` here: stacks run in the foreground in their own terminals. The test and dev stacks cannot both run on one laptop (Scylla needs
   `fs.aio-max-nr`).
3. The cloud runner (all values in ONE file, `~/.config/sdd-vps/config.env`): Hetzner token, SSH key, GitHub deploy key (write access), Claude token from
   `claude setup-token`, ntfy topic for your phone. Step by step: [`scripts/vps/README.md`](scripts/vps/README.md). Never set `ANTHROPIC_API_KEY` (it would bill the API instead of your subscription).
4. Images (once, a few cents, rebuild after big dependency changes): `scripts/vps/build-snapshot.sh` (backend, cpx42) and the front-end image with Chromium and the dev stack (ccx33, 32 GB).
   `run-remote.sh --image be|fe` picks one; `fe` is automatic when the target starts with `W`.
5. Once per project: write the specs (`scripts/sdd/write-specs.sh`, 13 to 17 hours, resumable), choose an order file in `scripts/sdd/orders/` (`by-flow.txt` reaches a working
   buy flow early; `!STOP <label>` lines are checkpoints), and run `python3 scripts/sdd/check-order.py` after editing it.

### Running a build, every time

```bash
git push origin master                              # the runner only sees GitHub
scripts/vps/run-remote.sh --image fe --hours 10     # next checkpoint, or add --until S48:P1 to stop earlier
scripts/vps/attach.sh                               # optional: watch the tmux session (Ctrl-b d to leave)
# close the laptop; your phone gets: created, working, 25/50/75 %, problems (each with a "recovered"), and one final message
git fetch origin && git checkout sdd/auto           # when it ends (the machine deletes itself)
```

How a run ends (the phone message says which): finished or checkpoint reached (everything pushed); time budget used (exit 76, run the same command again, it resumes);
out of Claude budget (exit 75, run again after the reset); login failed (exit 77, `claude setup-token`, update the config); finished with blocked capabilities (exit 78, each has a `BLOCKED.md`);
runner FAILED (the machine stays 2 hours for you to look). A new run resumes from the newest of `sdd/auto` and `sdd/wip` and merges `master` first. Hard stop: `--hours` + 1.

Useful knobs (environment variables of the loop): `UNTIL` (stop after a capability), `ORDER`, `COMMIT=1`, `MAX_GATE_REPAIRS` (5), `MAX_REPAIRS_PER_SPEC` (3), `REPAIR_BUDGET_MIN` (60),
`MAX_CHECKPOINT_REPAIRS` (= `MAX_GATE_REPAIRS`), `MAX_IMPLEMENT_PASSES` (10), `STEP_MAX_BUDGET_USD`, `PASS_TIMEOUT_S`, `CHECKPOINT_QA` (e.g. `"buy account"`: run those charters at the
checkpoint; `auto`: draft missing charters and run only those whose capabilities changed, see below), `QA_BUDGET_MIN` (30), `MAX_NEW_CHARTERS` (2), `MAX_QA_FIXES` (3), `CHECKPOINT_BASE`, `PW_WORKERS`, `PW_EXPECT_TIMEOUT_MS`.

### The morning routine (15 to 30 minutes)

1. Read the phone message, then `git fetch origin && git checkout sdd/auto`.
2. `python3 scripts/sdd/report.py --stdout | less`: per capability passes, repairs, gate failures, **flakes**, checkpoint failures, interventions, the QA section, trends.
3. `python3 scripts/decisions/triage.py open | head -20`: the defaults only you can judge. Edit `status:` in `docs/work/decisions/<id>.md` to `keep` or `change: <what you want>`;
   the next run applies every `change`. Never read `questions.md` files directly (hundreds of lines each): they are the raw input of the triage.
4. `cat scripts/qa/findings.tsv | tail`, `python3 scripts/qa/tally.py`: what the QA agent found and what the skeptic decided. Overrule a verdict with `tally.py set`.
5. Start the local stack (see the setup) and try the product for 10 minutes: `scripts/sdd/checkpoints/buy-ui.sh` (11 s) and `scripts/infra/doctor-live.sh`. Judgment stays with you.
6. Review living pages when you have time (`docs/spec/REVIEW.md`, start with S13, S10, S01), then sign: `python3 scripts/livespec/sign.py sign S13 --reviewer "<your name>"` (`sign.py status` shows what is signed).
7. Anything you found by hand: `scripts/sdd/note-intervention.sh "found by hand: ..."` and, if it taught something, a lesson in `docs/lessons.md`.
8. Merge when happy (the loop never merges): `git checkout master && git merge --ff-only sdd/auto && git push origin master`.

#### After the first run with the new harness (started 2026-10-13, `--qa auto`)

This run is the real test of everything built that day, so read it as an experiment, in this order:
- The boot check: the runner started the API in 30 seconds this time (the run before died because two modules were wired wrongly, lesson L-015). Every backend gate and every checkpoint now begins with `scripts/infra/boot-check.sh`. If a capability is BLOCKED with "the monolith is NOT ready", the Nest error is in its `.gate.log`.
- The `buy-ui` checkpoint should fail first: the scripted buy flow ends with the payment stuck in `PENDING` because the charge worker's ledger posting fails with `JournalInvalid` (the API log line `[payments-charge] message ... failed: JournalInvalid` is printed by the diagnosis). Whether the checkpoint repair agent fixes it is the best single test of the harness: look for `ckrepair-buy-ui-N` in `specs/.checkpoints/` and the line `CHECKPOINT-REPAIR: fixed`.
- The QA agent in the checkpoint (`CHECKPOINT_QA=auto`): `specs/.qa/` (reports), `scripts/qa/findings.tsv` (what each finding turned out to be), `packages/web/tests/qa/` (the failing tests it wrote and that the repair agent had to turn green). Expect a handful of findings per checkpoint, not zero: it covers only the charters whose capabilities changed, within about 30 minutes. New draft charters it wrote are in `scripts/qa/charters/` (`status: draft`); read them when you can.
- `python3 scripts/sdd/report.py --stdout`: the "QA agent" section has the ledger counts and precision; repairs and flakes have their own lines.
- Then, to take it: `git fetch origin && git checkout master && git merge --ff-only origin/sdd/auto` (it works only while nobody commits to master; if you did, `git merge origin/sdd/auto`).

### Local checks you can run any time

- Is the stack healthy (readiness, parked outbox rows, queues tasks wait for, dead-letter queues, search)? `scripts/infra/doctor-live.sh`. Static: `python3 scripts/infra/doctor.py`.
- The buy flow through the API, with a diagnosis when it fails: `scripts/sdd/checkpoints/buy-ui.sh`.
- A brand-new stack, the whole browser suite once, then removed (what a new machine sees): `scripts/qa/fresh-run.sh`. A throwaway stack for your own experiments:
  `WITH_WEB=1 scripts/qa/stack-up.sh`, then `scripts/qa/stack-down.sh <dir>`.
- Living spec: `python3 scripts/livespec/check.py` (+ `models.py check`, `test_livespec.py`). Lessons: `python3 scripts/lessons/check.py`. All unit tests of the tooling:
  `for t in scripts/lessons/test_lessons.py scripts/sdd/test_sdd.py scripts/infra/test_doctor.py scripts/livespec/test_livespec.py scripts/decisions/test_triage.py scripts/mutation/test_mutate.py; do python3 $t; done`.
- Do the unit tests catch wrong code? `scripts/mutation/changed.sh [REF]` or `python3 scripts/mutation/mutate.py <file.ts>` (survivors = untested lines).

### Which charters run: selection, drafted charters, the full pass

The QA agent cannot cover the whole product in a build, so with `CHECKPOINT_QA=auto` it covers what changed:
- `scripts/qa/select.py --explain`: a charter is due when a commit touched the `scope:` paths of one of its capabilities (`specs:` line) after the charter's last report in `specs/.qa`; a charter that never ran is due once its capabilities are built. Most changed capabilities first, then the longest without a run, until `QA_BUDGET_MIN` (default 30; a charter costs its minutes plus 6) is used. The first is always taken; the rest wait for a later checkpoint.
- `scripts/qa/make-charters.sh`: for built capabilities that no charter lists, a fresh session drafts one from the living page (`status: draft`, at most `MAX_NEW_CHARTERS` per checkpoint), or answers that there is no flow to walk (internal hubs) and the id goes to `scripts/qa/charters/.no-flow`. Read the drafts when you can; verify protects against a weak one.
- `scripts/qa/full.sh`: every charter, no budget, about 20 minutes each, so hours. Not part of the build loop: run it by hand or on a machine of its own before a release. It writes failing regression tests; the next checkpoint's repair agent fixes them.

### The QA pipeline and how far to trust it

`scripts/qa/pipeline.sh buy` does three things with no person in the middle: **find** (a fresh Claude session uses the running product like a person, guided by a charter in
`scripts/qa/charters/*.md`, with generic oracles and the living-spec rules), **verify** (a second skeptical session tries to reproduce each confirmed finding from its steps alone
and checks it against the spec and its "Known gaps"), **write the test** (a third session turns a reproduced finding into `packages/web/tests/qa/<charter>-<stamp>-<id>.spec.ts` (the report's time stamp keeps two runs' `D1` apart), which is
run and kept only if it fails now). Failing tests make the checkpoint fail, and the checkpoint repair agent fixes the product. Suspicious findings are never acted on.
Trust is earned by `scripts/qa/benchmark.sh`: it puts back defects that really happened (`scripts/qa/mutations/*.sh`: `groupId` on a standard queue, a missing queue, a silent
consumer, a missing search index) and checks the agent reports each, then one run on a clean build. State of the evidence: see "Where it stands" below.

### Learning the codebase while a run goes

- `docs/spec/` is the source of truth for what each capability does today (rules and behaviors, each with the test that proves it). Start with `docs/spec/README.md`, then the page of a capability (`capabilities/S13-payment-intents.md`).
- Every word that a rule uses with a special meaning is a link. A link to `docs/spec/terms/<word>.md` is a word of this system, defined once (a term page may link finer terms; the definitions never form a cycle). A link with an arrow, [HttpOnly ↗], is a general software word: it goes to the glossary `docs/spec/sw-external-terms.md`, which only points at MDN, an RFC or OWASP. A term page says "Used by" at the bottom: the rules that use it.
- `docs/humans/` is the generated map of the code (units, flows, events, jobs); each unit page ends with the spec pages that cover it. Spec = what should be true; humans = what is in the code.
- `docs/ops/` holds runbooks, SLOs and incident reports; `docs/work/` holds architecture notes, plans, the decision list and the notes of the day; `docs/showcase/` is the portfolio text; `docs/lessons.md` every failure turned into a rule.
- This file, the top section ("The map: every script, every agent, who starts whom"), is the one to read after a long break.

### Open items for you

- Read about 15 term pages and say if the number of pages is right (1,500 of them is a lot): `upstream`, `idempotency-key`, `event-consumer`, `inbox-table`, `loader`, `outbox-relay`, `published-version`, `search-facets`, `can-advance`, `decode-snapshot`, `replay-false`, `category-tracking`, `host-bff-cookies`, `combined-business-multiplier`, `rate-limit-policy`. If it is too many: `granularity` in `scripts/livespec/terms.config.json` (strict) and `terms.py consolidate --apply`; if too few, the other way. The levers are listed in `docs/spec/README.md`, "Levers".
- Sign the living pages, starting with S13, S10, S01 (`python3 scripts/livespec/sign.py sign S13 --reviewer "<your name>"`). Until then everything in `docs/spec` is a draft written by a model.
- Answer the top decisions in `docs/work/decisions/` (`triage.py open`).
- Tests may be replaced, split, renamed or deleted; a scenario may not disappear (lesson L-017). `scripts/sdd/check-tests.py integrity` fails a deleted or shrunk test file only when a scenario id it carried (`S34 AS-12`) is in no test any more and is not listed in `specs/<capability>/retired-scenarios.md` (`S34 AS-12: why`). Remaining weak spot: the guard compares with `HEAD`, and a run that ends commits unfinished work as `wip(sdd)`, so a deletion inside such a commit is not seen by the next run. After a run ends with a `wip` commit, glance at `git show --stat <wip commit>` for deleted `*spec.ts` files.
- Never push `sdd/auto` while a runner machine is alive: it pushes the branch itself every 15 minutes and at the end, and a push of yours makes its final push non-fast-forward (it then fails and the work stays on the machine).
- To discuss: the doctor (the repair agent that runs when a capability is stuck, `doctor-N` steps in `implement-specs.sh`). What it decides, why it said "needs human" twice on 2026-10-13 (a task it could not do in an unattended machine; a command that was not on its allow-list), and how to make it ask less and fix more. Ideas: tell it which environment it runs in (a disposable cloud runner, not a laptop), derive its allow-list from the tasks it reads, let it propose a change to the task instead of stopping.
- Rebuild the runner image (`scripts/vps/build-snapshot.sh`, a few cents) with the current Playwright version, so Chromium is already there: today the Playwright CDN crawled from Hetzner (20% in 11 minutes), the run sat in `playwright install chromium`, and the machine had to be replaced. `vm-run.sh` now retries (150 s per attempt, three mirrors), but with the browser in the image nothing is downloaded at boot at all and a start takes minutes less.
- Found by `scripts/infra/boot-app.sh` on 2026-10-14, not fixed: the standalone `apps/payment-processor` does not boot (`AuditService` needs `RequestContext`, then `ShopGuard` needs `ShopAccessService`: its module imports are incomplete; the monolith hides it). Fixed the same day: `apps/projector` aborted at boot for lack of `RouteTable` (now imports `ErrorUtilsModule`), and the dev `.env` lacked five settings that capabilities made required (share link keys, ads secret and instance). `projector`, `worker` and `core` boot on their own now.
- Later: an Opus second opinion on the word finder (it found a fifth to a third more phrases than Sonnet in a trial, many low value), the memory growth behind the backend sweep crashes, two unexplained browser flakes, `docs:check` (about 190 generated pages differ from the cache) and `pnpm slo:generate` (module resolution) which were already broken.

### Where it stands (honest)

- Built and verified on real runs: the build loop with gate and repair agent; checkpoints with the batched backend sweep and the browser sweep; the living spec (21 pages, 0 errors); the
  scripted buy flow (fails correctly with `groupId` back and with a queue missing); the live doctor; the QA agent on the buy charter (found 2 real findings on its first run).
- Proven locally on 2026-10-13 (not yet on the cloud): the whole chain through the real loop code (`implement-specs.sh` -> `checkpoint.sh` -> `pipeline.sh` -> failing test -> checkpoint repair agent -> checkpoint passes), charter selection by change, drafted charters, deduplication of findings, the QA benchmark (4 of 4 seeded defects found; the clean-build run reported 5 findings, all real gaps of the unfinished product).
- Built and tested only on fakes or fixtures, first real cloud run pending: the flake signal, the metrics report on real data, the decision triage in the loop, `CHECKPOINT_QA=auto` over a whole run, the boot check on the runner.
- Not done: the other three QA charters have not been run; the trending-cache defect is not in the benchmark; the memory growth behind the backend sweep crashes and two
  unexplained browser flakes (product-page focus order, search at 320 px) are open (runbook, follow-ups); the living pages are drafts until you sign them.
- Cost reference: about $0.22 to $0.33 per machine hour (cpx42 / ccx33); a 10 hour run is a few dollars plus the Claude subscription usage.

### Where things live

- `scripts/sdd/` the loop (`implement-specs.sh`, `checkpoint.sh`, `checkpoint-repair.sh`, `lib.sh`, `failures.py`, `report.py`, order files, checkpoint scripts in `checkpoints/`).
- `scripts/vps/` the cloud runner. `scripts/qa/` QA agent, pipeline, charters, mutations, benchmark, throwaway stack. `scripts/infra/` doctors. `scripts/livespec`, `scripts/lessons`,
  `scripts/decisions`, `scripts/mutation`.
- `specs/` per-capability spec folders (spec, plan, tasks, `questions.md`, `gaps.md`, `BLOCKED.md`), `specs/.checkpoints/` pass markers, `specs/.qa/` QA reports.
- `docs/spec/` the living specification. `docs/lessons.md`. `docs/work/decisions/`. `docs/ops/incidents/`. `docs/reports/`. `docs/work/architecture/sdd-runbook.md` (why each part exists).

## Run the e2e specs (verified path)

The e2e specs run against a separate test stack (`docker-compose.test.yaml`, ports shifted so it can run next to the dev stack). Every `up` starts from a clean slate.

```bash
pnpm install
cp packages/backend/env/test.env.example packages/backend/.env.test

# Whole test stack: Postgres, Redis, Redpanda, Elasticsearch, ClickHouse, Scylla, DynamoDB, MinIO, ElasticMQ
moon run infra-test-up        # foreground, keep it in its own terminal
moon run infra-test-migrate   # from another terminal, once the stores are up

# One spec, or a folder of them
pnpm --filter api run test:e2e -- libs/domains/orders/checkout
pnpm --filter api run test:e2e -- libs/domains/payments
```

Specs that only need Postgres and Redis (jobs, rate limiter, ...) start much faster with just those two services: see the quick start in the README.

## Run the whole stack (dev)

There is no `.env` template for the dev stack yet. Create `packages/backend/.env` starting from `env/test.env.example` plus `env/showcase.env.example`, then:

```bash
moon run infra-setup             # starts the databases, Kafka, search, ... in the foreground, then runs schemas and topics
moon run dev-monolith            # (second terminal) API + workers + projectors in one process on :8000, watch mode
moon run dev-web                 # web app on :3000
```

Infra tasks come in the same four flavours for the dev stack (`infra-*`) and the test stack (`infra-test-*`). All of them run in the foreground, never detached; Ctrl+C stops the stack.

| Task | What it does |
| --- | --- |
| `infra-up` / `infra-test-up` | Start the stack |
| `infra-reup` / `infra-test-reup` | `pnpm infra-clean` first, then start |
| `infra-setup` / `infra-test-setup` | Start, then run the migrations as soon as the stores answer |
| `infra-resetup` / `infra-test-resetup` | `pnpm infra-clean`, start, migrate |
| `infra-migrate` / `infra-test-migrate` | Only the migrations, against a stack that is already up |
| `infra-down` / `infra-test-down` | Stop the stack from another terminal |

`pnpm infra-clean` is machine-wide: it stops and removes every Docker container, then prunes volumes and networks.

Or run the apps separately, one terminal each:

```bash
moon run dev-api        # core :8000
moon run dev-bff        # :8006
moon run dev-sse        # :8001
moon run dev-worker     # :8003
moon run dev-projector  # :8002
moon run dev-web        # :3000
```

Tracing, metrics, logs and alerts (Grafana, Jaeger, Prometheus, Loki, Alertmanager, exporters) are in the same compose file behind the `observability` profile and are not started by `infra-up`. Run `moon run infra-up-observability` when you want them; otherwise set `OTEL_SDK_DISABLED=true` in `packages/backend/.env` so apps don't try to export traces.

The chat WebSocket gateway is a separate Rust binary: see [`packages/hft-platform/README.md`](packages/hft-platform/README.md).

**Load tests:** four k6 flows (payment, search, seller stats, chat), each with
its own 100k-user seeder. See
[`packages/backend/scripts/load-tests/README.md`](packages/backend/scripts/load-tests/README.md).

## Service ports

| Service                            | Port            |
| ---------------------------------- | --------------- |
| Edge Worker                        | `8787`          |
| Nest API                           | `8000`          |
| Chat Gateway (Rust)                | `8090`          |
| PgBouncer (profile `pooling`) → Postgres | `6432` / `5300` |
| Kafka / Pandaproxy                 | `9092` / `8082` |
| Redis HTTP (edge)                  | `8079`          |
| Elasticsearch                      | `9200`          |
| ClickHouse HTTP                    | `8123`          |
| Jaeger UI                          | `16686`         |
| MinIO (S3) / console               | `9100` / `9101` |
| ElasticMQ (SQS) / UI               | `9324` / `9325` |
| DynamoDB Local                     | `8100`          |
| ScyllaDB (CQL)                     | `9042`          |
| Mailpit SMTP / UI                  | `1025` / `8025` |
| ClamAV                             | `3310`          |
| Debezium Connect (`--profile cdc`) | `8083`          |

## Spec-driven Development Commands

Generating constitution:

```
/speckit.constitution Read the architectural patterns and notes inside interview-prep/. Use these notes as the absolute source of truth to generate this project's constitution.

You may scan the existing codebase for context, but treat the code as an imperfect, AI-generated draft. If the codebase contradicts the notes in interview-prep/, the notes win.

Extract these patterns into strict, falsifiable, decision-ready rules.
DO NOT write vague platitudes like "maintain quality" or "write clean code". Every principle must be a hard constraint that can be objectively validated during a pull request.

Ensure the constitution explicitly defines:
1. The required architectural boundaries (e.g., how routing, data access, and state management must be separated).
2. Strict rules for what components are allowed to communicate with each other.
3. The exact testing mandate (what must be tested and how).
```

Running spec generation:

```
Suggested order:
1. Commit.
2. DRY_RUN=1 scripts/sdd/write-specs.sh S10 W03 J01 to read one prompt of each kind.
3. Pilot with scripts/sdd/write-specs.sh S01 S10 and read the results.
4. Run the full scripts/sdd/write-specs.sh.
5. Review the questions.md files.
```

Full unattended run (after the pilot; details in [`docs/work/architecture/sdd-runbook.md`](docs/work/architecture/sdd-runbook.md)):

```bash
# 1. Commit, then write all 67 specs (55 backend S, 7 web W, 5 journeys J). Takes roughly 13–17 hours.
#    Unfinished specs (no .spec-done marker) are cleared and redone, including the S01/S10 pilot.
#    Failures are retried after 10/30/60/120 min, then the run moves on. Re-run the same command to resume.
tmux new -s specs                                   # detach: Ctrl-b d, re-attach: tmux attach -t specs
cd <repo root>
systemd-inhibit --what=sleep:idle --why="SDD spec run" \
  scripts/sdd/write-specs.sh 2>&1 | tee -a specs-run.log

# Progress: target is 67
tail specs-run.log
ls specs/*/*/.spec-done | wc -l

# 2. Optional: veto any default (agents pick the most production-grade option and tag changes [BREAKING])
scripts/sdd/review-questions.sh

# 3. Commit, then implement spec by spec (needs the test stack; W and J also need the dev stack)
moon run infra-test-setup     # foreground: keep it in its own terminal
# For W and J, each in its own terminal (infra-setup and dev-monolith keep running in the foreground):
#   moon run infra-setup     # dev stores, then schemas and topics
#   moon run dev-monolith    # API + workers + projectors on :8000, watch mode

claude-personal-setup                                # this terminal uses ~/.claude-personal (function in ~/.bashrc)
COMMIT=1 scripts/sdd/implement-specs.sh              # short run, terminal stays open

# Long or walk-away run: keep it alive if the window closes (tmux) and keep the laptop awake (systemd-inhibit).
# `env` is needed because systemd-inhibit runs a program, not a bare VAR=value.
tmux new -s impl                                     # detach: Ctrl-b d, re-attach: tmux attach -t impl
claude-personal-setup
systemd-inhibit --what=sleep:idle --why="SDD implement" env COMMIT=1 scripts/sdd/implement-specs.sh
```

Watch a run from a second terminal or tmux pane (separate process, so it also notices if the loop dies):

```bash
scripts/sdd/monitor.sh              # logs every finished task to .sdd-monitor/progress.log, notifies quietly at 25/50/75/100 %
                                    # and loudly only for problems: stalled, one task too long, loop gone, disk, test container exited
scripts/sdd/monitor.sh --status     # one-line progress, sends nothing
tail -f .sdd-monitor/progress.log
```

Each problem alert is paired with a quiet "recovered" message, so a raised alert always gets an ending. Settings:
`STALL_MIN`, `TASK_WARN_MIN`, `MONITOR_INTERVAL`, `NTFY_TOPIC` (phone), `HEARTBEAT_URL` (dead-man's switch), see the header
of the script.

How the run behaves (details in the runbook):

- It runs until every requested spec is built or the Claude usage limit is hit, then stops cleanly and sends a desktop
  notification: "finished", "out of budget" (exit code 75), or "stopped" with the spec and step.
- Re-run the same command to resume. Plan, tasks and analyze are skipped for specs that already have them, and
  `implement` continues at the first unchecked task in `tasks.md`.
- A failing gate is given back to the agent to repair (`MAX_GATE_REPAIRS`, default 5) before the run stops.
- `UNTIL=S16` stops after that capability; `STEP_MAX_BUDGET_USD=5` caps a single step (leave it unset to run until the
  plan limit); `MAX_IMPLEMENT_PASSES` (default 10) bounds the fresh-context passes per spec.
- Closing the laptop lid can still suspend it; keep it open or change the lid setting.
- Order: `ORDER=by-layer` (default, `scripts/sdd/orders/by-layer.txt`: platform, identity, money, ..., web, journeys) or
  `ORDER=by-flow` (`orders/by-flow.txt`: priority-first, to reach a working browser flow early).
  - An entry `W02:P1` builds only that spec's user stories of priority P1 (plus Setup and Foundational): `tasks.md` is
    grouped in phases, each story phase is labelled `(P1)`, `(P2)`..., and the pass leaves the later phases unticked. A plain
    `W02` entry later in the file finishes it (the loop resumes at the first open task). Markers: `.implemented-P1` after
    the limited pass, `.implemented` after the whole spec. The gate's scenario check skips the scenarios only deferred
    stories cover; what a limited pass cannot reach yet is listed under "Deferred until a later pass" in the spec's `gaps.md`.
    `# needs: S01 S02` after a limited entry declares what its pass really uses.
  - `!STOP <label> <message>` lines are checkpoints: the run stops once there so you can try what exists, and the next run
    passes it. Before pausing, `scripts/sdd/checkpoint.sh <label>` runs the whole backend e2e suite (and Playwright when
    the dev stack is up) as a regression sweep, then `scripts/sdd/checkpoints/<label>.sh` if present (a scripted walk of
    the flow); a failure stops the run instead of pausing. With `COMMIT=1` the "passed" marker (`specs/.checkpoints/<label>`) is committed; delete it
  to stop at that checkpoint again. Switching orders mid-way is safe: built specs are skipped either way. `python3 scripts/sdd/check-order.py` verifies that
  every order builds each capability after the ones its spec depends on, that each `:P1` entry's declared needs come
  before it, and that every capability gets a plain entry (run it after editing an order file).

### Running the loop on a Hetzner VPS

`scripts/vps/` creates a machine per run, runs the loop there, pushes `sdd/auto`, notifies your phone and deletes the machine.
Setup and use are in [`scripts/vps/README.md`](scripts/vps/README.md); the design is in
[`docs/work/architecture/vps-runner-plan.md`](docs/work/architecture/vps-runner-plan.md). In short, after the one-time setup:

```bash
git push origin master                           # the machine only sees what is on GitHub
scripts/vps/build-snapshot.sh                    # once: the runner image
scripts/vps/run-remote.sh --until S53 --hours 4  # one capability; close the laptop and wait for the phone message
git fetch origin && git checkout sdd/auto        # afterwards: test on localhost
```

Loop settings the runner uses: `RUN_DEADLINE` (epoch seconds, hard end; the loop exits 76), `PUSH_BRANCH` (push after every
commit), exit codes 75 (usage limit), 76 (time budget), 77 (Claude login failed).

### Living specification (`docs/spec`, `scripts/livespec`)

What the system does today, checked against the code and the tests. Pages are `draft` until you read and sign them (recipe: `docs/spec/REVIEW.md`).

```sh
# is everything true? (links, proofs, code references, routes, concepts, state machines, signed items)
python3 scripts/livespec/check.py
python3 scripts/livespec/check.py --base origin/master      # also: code changed under a page, page did not
python3 scripts/livespec/check.py --strict                  # warnings (style, unproven rules) fail too
python3 scripts/livespec/check.py --fix-backlinks           # refresh the "used by" blocks of the concept pages

# review and sign (a human action; agents cannot run it)
python3 scripts/livespec/sign.py status                     # who signed what, and what changed since
python3 scripts/livespec/sign.py sign S13                   # sign every rule and behavior of the page you read
python3 scripts/livespec/sign.py sign S13 --only S13.R-01,S13.B-02
python3 scripts/livespec/sign.py diff S13                   # the page's git diff since your signature

# the formal layer
python3 scripts/livespec/models.py check [--fix]            # state machines: total, deterministic, matched to the code (--fix redraws the diagrams)
python3 scripts/livespec/run_models.py                      # Quint models: type-check and simulate (needs Node; the first run downloads Quint)

# generate (the first draft only; pages are authored afterwards)
python3 scripts/livespec/generate.py --facts                # what would be fed to the model, no model calls
python3 scripts/livespec/generate.py --only S99             # a draft page for a newly built capability (the loop does this itself)
python3 scripts/livespec/generate.py --only S13 --force     # regenerate a DRAFT page (a signed page is never overwritten)
python3 scripts/livespec/generate.py --concepts --force     # regenerate the concept pages from the capability pages
python3 scripts/livespec/generate.py --system               # rebuild docs/spec/system.md

# the tests of the scripts
python3 scripts/livespec/test_livespec.py
```

### Lessons loop (`docs/lessons.md`, `scripts/lessons`)

A failure is written down once; the agents read the failure classes before they work; a check keeps every claimed prevention real.

```sh
python3 scripts/lessons/digest.py        # the failure classes and one-line rules, at most 40 lines (what the agents' prompts get)
python3 scripts/lessons/check.py         # exit 1 when a `prevented` lesson links something that does not exist
python3 scripts/lessons/test_lessons.py  # the tests of both scripts (16)
```

- Add a lesson in two places: a line `- L-nnn date class status` in the index, and an entry `## L-nnn title` with a `**Rule:**` line, the symptom and cause,
  and `**Prevention:**` with backticked links (file paths, commit hashes). Status `prevented` means every link exists; `open` needs no link.
- `check.py` also lists `open` lessons older than 14 days and prints the repeats per class (a lesson in a class that already had one). Neither fails the check.
- `scripts/sdd/implement-specs.sh` puts the digest into the plan, tasks, analyze, implement, converge, gate-repair and repair-agent prompts (`lessons_block` in `scripts/sdd/lib.sh`).
  `write-specs.sh` is not changed: spec writing does not build or repair anything.

### Metrics, interventions and the report (`.sdd-metrics`, `scripts/sdd/report.py`)

`implement-specs.sh` appends one JSON line per step to `.sdd-metrics/steps.jsonl` (what is recorded and why the file is committed, not ignored: runbook, "Metrics").

```sh
scripts/sdd/note-intervention.sh "found by hand: payment stays PENDING (queue missing)" S48   # tag what a person had to do; the capability is optional
python3 scripts/sdd/report.py                  # writes docs/reports/<today>.md from .sdd-metrics/steps.jsonl
python3 scripts/sdd/report.py --stdout         # print it instead
python3 scripts/sdd/report.py --input other.jsonl --out-dir /tmp/reports --date 2026-10-13
python3 scripts/sdd/test_sdd.py                # tests of report.py, failures.py, the metric helpers and the checkpoint repair loop (42)
```

- The report has, per capability: implement passes, repairs (and how many changed no code), gate failures, flakes, interventions, elapsed time; per checkpoint:
  failures, repairs, flakes; then the trend over runs, which also shows when a limit such as `MAX_GATE_REPAIRS` changed between two runs.
- Try it without a run: put a few lines in a scratch file (see `FIXTURE` in `scripts/sdd/test_sdd.py` for the format) and pass it with `--input`.

### Repair of a failed checkpoint, and the flake signal (`scripts/sdd/checkpoint-repair.sh`, `scripts/sdd/failures.py`)

A failed checkpoint no longer ends the run at once: a repair agent gets the failing tests, the page snapshots and the log, then the checkpoint runs again.

```sh
scripts/sdd/checkpoint-repair.sh --dry-run buy-ui                       # what the loop would do for that checkpoint, with the prompt; runs and writes nothing
scripts/sdd/checkpoint-repair.sh --dry-run buy-ui --log some.log        # the same, for a log you have (e.g. a copy of specs/.checkpoints/<label>.log)
python3 scripts/sdd/failures.py names specs/.checkpoints/buy-ui.log     # the failing tests the parser finds in a log, one per line
python3 scripts/sdd/failures.py digest specs/.checkpoints/buy-ui.log --label buy-ui --results-dir packages/web/test-results
```

- `MAX_CHECKPOINT_REPAIRS` (default: `MAX_GATE_REPAIRS`, 5) bounds the attempts; the time comes out of the shared `REPAIR_BUDGET_MIN`.
- A gate or checkpoint that passes after repairs that changed no code is a flake: its failing tests are written under "Flaky tests" in the spec's `gaps.md`
  (checkpoint: `specs/.checkpoints/<label>.flakes.md`) and named in the final notification.

### Infrastructure doctor, static half (`scripts/infra/doctor.py`)

Every queue, topic, bucket and table the backend code names, checked against what the local stack defines (`elasticmq.conf`, the compose files, the Kafka topic script,
the migrations, `dynamodb/*.json`, `cql/*.cql`). It reads files only: no Docker needed. Exit 1 and a `MISSING` line when something is not defined.

```sh
python3 scripts/infra/doctor.py                    # every item, OK or MISSING
python3 scripts/infra/doctor.py --missing-only     # only the problems and the counts
python3 scripts/infra/doctor.py --only queues,topics   # kinds: queues, topics, buckets, tables
python3 scripts/infra/test_doctor.py               # its tests (19), including a fixture where one queue is missing
```

- What it finds today and what it cannot see: runbook, "The infrastructure doctor (static half)". It exits 1 on this repository (23 topics that nothing creates), so it is not part of the gate yet.
- A new queue, topic, bucket or table needs a definition in the stack file named in the `MISSING` line; the doctor only reads, it never fixes.

### QA agent, scripted buy flow and the live doctor (`scripts/qa`, `scripts/sdd/checkpoints`, `scripts/infra/doctor-live.sh`)
- A throwaway stack (own compose project, empty volumes, seeded): `WITH_WEB=1 scripts/qa/stack-up.sh` prints `QA_DIR=<dir>` when the API (and the web server)
  answer; `scripts/qa/stack-down.sh <dir>` removes everything of it. It refuses to run while your own dev stack is up (same ports). About 4 minutes.
- The scripted buy flow, through the API only (register, product, cart, checkout, pay, wait for `PAID`; about 11 s): `scripts/sdd/checkpoints/buy-ui.sh`. Exit 0 = the flow works.
  The checkpoint `buy-ui` runs it. On failure it names the stuck step and what is behind it (payment, order, outbox rows, a missing queue).
- Is the running stack healthy (readiness checks, parked or stale outbox rows, queues that tasks wait for, dead-letter queues, search)?  `scripts/infra/doctor-live.sh`.
- The whole browser suite on a fresh stack, then everything removed (about 8 minutes): `scripts/qa/fresh-run.sh [playwright args]`.
- The QA agent (a fresh Claude session that uses the product like a person; it never edits the repository):
  `scripts/qa/run.sh buy` (charters: `scripts/qa/charters/*.md`: buy, cart-odd, account, discover; `--minutes N`). Reports: `specs/.qa/<date>-<charter>.md`, with the
  Playwright scripts it used next to it. Exit 1 if a report holds a CONFIRMED defect. It needs the stack and the web server up.
- Does the agent find real defects? `scripts/qa/benchmark.sh`: puts back defects that happened (`scripts/qa/mutations/*.sh`), runs the agent on each, then once on a clean build;
  writes `scripts/qa/benchmark-<date>.md`. Needs `packages/backend` clean (it restores files with `git checkout`).

## Developer tooling

Three things live next to the code: an Obsidian vault over the repo, a generated codebase map, and the spec-driven
development scripts.

### Obsidian vault

Open the repo root as a vault (Obsidian → Open folder as vault). `.obsidian/` is gitignored, so a fresh clone has to
recreate its settings. Obsidian only indexes markdown, so keep it away from `node_modules` before the first open.

1. Create `.obsidian/app.json`:

   ```json
   {
     "userIgnoreFilters": [
       "/(^|\\/)node_modules\\//",
       "/(^|\\/)\\.git\\//",
       ".agents/",
       ".specify/",
       ".claude/",
       ".moon/",
       ".github/",
       ".aider",
       "infra/",
       "packages/",
       "scripts/"
     ],
     "useMarkdownLinks": true,
     "newLinkFormat": "relative",
     "alwaysUpdateLinks": true
   }
   ```

   Same list in the UI: Settings → Files & links → Excluded files → Manage. If you open the vault first, close and
   reopen it after editing the file.

2. Excluded folders still show as empty shells in the file explorer. Hide them with a CSS snippet saved as
   `.obsidian/snippets/hide-noise.css`, then switch it on under Settings → Appearance → CSS snippets:

   ```css
   .nav-folder:has(> .nav-folder-title[data-path$="node_modules"]),
   .nav-folder:has(> .nav-folder-title[data-path="infra"]),
   .nav-folder:has(> .nav-folder-title[data-path="packages"]),
   .nav-folder:has(> .nav-folder-title[data-path="scripts"]) {
     display: none;
   }
   ```

   The code stays on disk and in git; it is only out of the vault's index, graph and sidebar.

3. Links to code (`.ts` files) are not notes, so Obsidian hands them to your system's default app. To open them in the
   editor window that already has this repo open, make the editor the default for those file types. On Linux the
   catch is that the system classifies `.ts` as a Qt translation file (`text/vnd.trolltech.linguist`) and `.tsx` as
   `application/x-tiled-tsx`, so setting `text/x-typescript` does nothing (check with `gio info FILE | grep -i type`):
   `xdg-mime default cursor.desktop text/vnd.trolltech.linguist application/x-tiled-tsx text/x-typescript`.
   Line anchors (`#L19`) are ignored that way.

Folders in the vault:

| Folder                                           | Owner                 | Notes                                                                                       |
| ------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------- |
| `docs/humans/`                                   | the docs generator    | Rewritten on every run. Do not hand-edit; any other `.md` file in it is deleted.            |
| `interview-prep/`                                | you                   | Hand-written theory notes. `interview-prep/my-practice/` is gitignored (private exercises). |
| `docs/work/architecture/`, `docs/ops/runbooks/`, `specs/` | you / the SDD scripts | Hand-written or agent-written, committed.                                                   |

### Codebase map (`scripts/docs`)

Builds `docs/humans/`: one page per unit, flow and topic, linked into a graph that can be browsed in Obsidian. Static
analysis finds the structure; an LLM writes the words. Details, limits and configuration:
[`scripts/docs/README.md`](scripts/docs/README.md). Needs Node 22.18 or newer, no install.

```sh
pnpm docs:extract                           # what static analysis found (free, instant)
pnpm docs:plan --unit domain/payments       # how much a run would cost (no LLM calls)
pnpm docs:generate --unit domain/payments   # one unit: file summaries -> topic map -> topic pages -> unit page
pnpm docs:generate                          # everything (large; see below)
pnpm docs:check --strict                    # CI gate: stale summaries, or pages out of sync with the cache
pnpm docs:render                            # rebuild the markdown from the cache only (no LLM)
pnpm docs:theory                            # link interview-prep sections to the code that implements them
```

- `generate` renders at the end, so there is no separate step for Obsidian: open `docs/humans/README.md`.
- **Cache:** `docs/humans/.cache/` is keyed by a hash of each node's source and inputs. Commit it: a fresh clone then
  regenerates only what changed, and everyone renders identical pages. `--force` regenerates the selected nodes anyway.
- **Order:** a topic page can link to another unit only if that unit's topic map already exists. For a full run, first
  do `pnpm docs:generate --level file,capmap` (every unit's file summaries and topic map), then generate units in any
  order. `--unit` takes several names: `--unit domain/orders,domain/marketing`.
- **LLM access:** `--provider auto` uses `ANTHROPIC_API_KEY` if set (fast, parallel), otherwise the logged-in `claude`
  CLI (set `DOCS_CLAUDE_CONFIG_DIR` to run it under a separate Claude Code profile). `--provider mock`
  tests the pipeline with placeholder text; use it only with a throwaway `outDir`, because it writes into the cache.
- **Cost and time:** `--max-calls N` is a hard cap. One unit takes minutes; the whole repo is a few thousand calls
  (mostly small ones), so use an API key for that run.
- **Do not interrupt a run.** The topic-page level saves its cache only when the whole level finishes, so Ctrl+C loses
  the pages written in that run.
- **Depth:** a topic page splits itself into sub-topics until pieces are self-explanatory. Tune `maxConceptDepth`
  (default 4) and `maxConceptsPerUnit` (default 40) in `scripts/docs/docs.config.json`.
- **Theory links:** `pnpm docs:theory` adds an **In this codebase** block under every section of the notes in
  `interview-prep/`, at any heading depth. Each link is Ctrl+clickable and lands on the exact function (`file.ts#L21`).
  Code is always linked; topic pages are linked next to it only if they have been generated.
- **Theory links, safety:** it writes only between the `theory-links:start` and `theory-links:end` HTML-comment
  markers, so your text is never changed, and it never reads `interview-prep/my-practice/`.
  `docs/humans/theory-coverage.md` shows the gaps in both directions.
- **After a reimplementation:** run the two theory commands below again. Only changed files, and only notes whose
  candidates changed, are redone. For topic links, generate topic pages for the units you want to study
  (`pnpm docs:generate --unit ...`), then run `pnpm docs:theory` again.

Cheap path for theory links, once the code you want linked exists (no topic pages needed):

```sh
pnpm docs:generate --level file   # summaries of every file and its exported functions (~800 small Haiku calls)
pnpm docs:theory                  # ~45 calls: link every note section to the code that implements it
git diff interview-prep           # review: read the model's one-sentence "how" lines critically
```

### Spec-driven development (`scripts/sdd`)

Bulk spec writing and implementation on top of spec-kit, driven by the 67-row catalog in
[`scripts/sdd/capabilities.tsv`](scripts/sdd/capabilities.tsv). Full procedure:
[`docs/work/architecture/sdd-runbook.md`](docs/work/architecture/sdd-runbook.md).

```sh
DRY_RUN=1 scripts/sdd/write-specs.sh S10       # print the prompt for one capability, run nothing
scripts/sdd/write-specs.sh S01 S10             # pilot: write these specs
scripts/sdd/write-specs.sh payments web        # by domain column (`web` and `journeys` too)
scripts/sdd/write-specs.sh                     # all capabilities; resumes if re-run
scripts/sdd/review-questions.sh                # the [BREAKING]/[CONTRACT] defaults the agents chose
COMMIT=1 scripts/sdd/implement-specs.sh S10    # plan -> tasks -> analyze -> implement -> converge -> gate
```

- A spec counts as written when `spec.md`, `test-plan.md`, `gaps.md` and `questions.md` exist and `.spec-done` is
  present; interrupted ones are cleared and redone. Failures wait 10/30/60/120 minutes (`RETRY_WAITS`), then the run
  moves on.
- Implementation stops at the first failing gate and resumes from `.implemented` markers. Backend specs need
  `moon run infra-test-setup` (own terminal); web and journey specs also need `moon run infra-setup` and
  `moon run dev-monolith`.
- To use a separate Claude Code profile, set `CLAUDE_CONFIG_DIR=DIR` for these scripts. Long runs:
  `systemd-inhibit --what=sleep:idle` inside `tmux`, as in the runbook.
