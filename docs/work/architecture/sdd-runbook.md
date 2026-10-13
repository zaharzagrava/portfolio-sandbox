# SDD Runbook: from refactor to verified domains

The order of work after the domain map and constitution v3.1.0. Run the steps in order, one at a time
(no parallel agents). Related files:

| File                                                                     | Role                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| [`domain-map.md`](domain-map.md)                                         | target domains and table ownership                                              |
| [`pattern-map.md`](pattern-map.md)                                       | every Interview-Prep pattern → where it lives → which capability spec proves it |
| [`debt-register.md`](debt-register.md)                                   | every open constitution violation (D-1…D-15) and what pays it                   |
| [`scripts/sdd/capabilities.tsv`](../../../scripts/sdd/capabilities.tsv)     | 67 capabilities, one spec each, in execution order: 55 backend (S), 7 web (W), 5 journeys (J) |
| [`scripts/sdd/spec-prompt.md`](../../../scripts/sdd/spec-prompt.md)         | the `/speckit-specify` prompt template (backend); `spec-prompt-web.md`, `spec-prompt-journey.md` for W and J |
| [`scripts/sdd/write-specs.sh`](../../../scripts/sdd/write-specs.sh)         | step 2: writes all specs, headless, sequentially                                |
| [`scripts/sdd/implement-specs.sh`](../../../scripts/sdd/implement-specs.sh) | step 4: plan → tasks → analyze → implement → converge → gate, per spec          |

---

## Step 1 — Finish the refactor

Paste each block into Claude Code as-is, in order. Each one ends with the same verification gate as
batch 3: `tsc` 0 errors, unit suite unchanged, `jest db/` 5/5, `pnpm check:module-graph` 9/9, all 9
apps build, 52 e2e specs listed, 0 deep `@app/domains/<d>/` imports.

### 1a. Batch 4 — social, discovery, insights (about 120 files)

```text
/speckit.plan Continue Phase 2 with Batch 4, using the same pipeline (phase2-batch4-moves.tsv → phase2-move.sh → phase2-entrypoints.ts). Read docs/work/architecture/domain-map.md and the constitution first.

Domains to create:
- community ← discussions + feed (D5: zero Postgres tables, ScyllaDB/Redis only)
- content ← stories
- notifications ← notifications (largest folder, 28 files: router projector, provider webhooks controller, channel workers)
- discovery ← search-admin + autocomplete + recommendations + trending (read-model domain: projectors and consumers go in infra/, no Postgres tables)
- seller-insights ← leaderboards + seller-stats + crawler

Rules: the same as batch 3 (I.1 layout, events in application/events/, single index.ts, no forwardRef, fix cycles at the source, no route or behavior changes). Leave realtime/topics.ts alone (D3 belongs to the cleanup phase). Keep discussions/ranking.spec.ts failing exactly as it does now; moving it must not change its result. Same verification gate as batch 3. Don't run docker. Don't commit.
```

### 1b. Batch 5 — platform and growth (about 100 files; empties all domain folders)

```text
/speckit.plan Continue Phase 2 with Batch 5, the last move batch, using the same pipeline (phase2-batch5-moves.tsv → phase2-move.sh → phase2-entrypoints.ts). Read docs/work/architecture/domain-map.md and the constitution first.

Domains to create:
- developer-platform ← public-api + webhooks + widget (widget owns the WidgetSite table, so it's a domain, not composition)
- marketing ← ads + share-links
- experimentation ← flags + analytics
- assistant ← assistant + knowledge

Rules: the same as batches 3–4. Afterwards libs/common/src may contain only: models/all-models.ts, types.ts, index.ts, seeds/, utils/test-utils/, bff/batch-read.controller.ts. List anything else as an error. Same verification gate. Don't run docker. Don't commit.

Also new debt, modify the sdd-runbook or anything else related if needed:
- D-12: discovery owns no tables, yet four of its services read catalog's "Product" table with raw SQL; so does community's product-feed projector. They should use catalog's exported service or a read model instead. Capability specs S26 and S32–S35 will
pick this up through their gaps.md.
- D-13: discovery's count-min sketch imports murmur3 from the legacy flags folder, and pure domain code shouldn't depend on another domain. Since murmur3 is a generic hash, I added a note under the batch 5 prompt in the runbook: move it to
libs/common/core rather than into experimentation. Append that sentence when you paste the batch 5 prompt.
```

**Batch 5 is done ([specs/006](../../../specs/006-phase2-batch5-domains/plan.md)), including D-13: `murmur3` moved to
`libs/common/core`. D-12 and every other open item now live in [`debt-register.md`](debt-register.md).**

### 1c. Phase 3 — cleanup and enforcement (not a move batch)

```text
/speckit.plan Execute Phase 3: retire libs/common/src and turn on boundary enforcement. Read docs/work/architecture/domain-map.md, the constitution, and docs/work/architecture/debt-register.md (rows D-1…D-5 and D-9 are this phase's; mark each `resolved (Phase 3)` when done).

Steps, in this order, with the verification gate after each:
1. D-1: remove every infrastructure → domain import (elasticsearch → catalog, kafka/outbox → payments; cassandra/dynamo/redis → utils/test-utils cleanup registry becomes an infrastructure port, with the registry itself moving to test/).
2. Move seeds/ → packages/backend/test/seeds and utils/test-utils → packages/backend/test/utils.
3. D-2: split types.ts (generic types → libs/common/types; RequestWithUser → identity).
4. D-4: split bff/batch-read.controller.ts into tenancy and catalog batch endpoints, keeping the same routes and response shapes.
5. D-9: delete all-models.ts; each domain module registers its own models; sse-gateway and the test harness import the domain modules instead.
6. D-3: replace realtime/topics.ts with a topic registry that each domain fills on module init.
7. D-5: delete libs/common/src/index.ts and the empty libs/common/src. Remove the @app/common → libs/common/src fallback from tsconfig, both jest mappers, and the esbuild plugin.
8. X.6: add dependency-cruiser (or eslint boundaries) with the constitution X.5 rules as a script, and fix or record every violation it reports (the known domain cycle is D-11/D-12/D-15; record, don't fix).

Steps 4–6 change runtime wiring: prove each one with the module-graph check and by updating the affected e2e specs (typechecked, not run). Don't run docker. Don't commit.
```

All remaining debt is in [`debt-register.md`](debt-register.md). Phase 3 pays D-1…D-5 and D-9. The rest (D-6
layering, D-7/D-12 cross-domain data access, D-8, D-10, D-11, D-14, D-15) needs real refactoring under
tests, so each capability's `gaps.md` picks up its domain's register rows plus its
`pnpm check:table-ownership` lines, and the implementation loop (step 4) pays them down. Once that report
is empty, add `pnpm check:table-ownership --strict` to the gate in `scripts/sdd/implement-specs.sh`.

**Phase 3 is done ([specs/007](../../../specs/007-phase3-cleanup/plan.md)).** **Then commit.** Step 2 onward assumes a clean tree, and `implement-specs.sh` can commit per capability.

---

## Step 2 — Write all specs (bulk, headless, sequential)

### What gets specified

| Kind | IDs | Covers | Spec folder | Template |
|---|---|---|---|---|
| Backend | S01–S55 | Every domain capability, infrastructure lib, and the BFF: API behaviour down to edge cases (concurrency, idempotency, illegal transitions, cross-tenant access, limits), events, jobs | `specs/domains/` | `spec-prompt.md` |
| Web | W01–W07 | Every page in `packages/web`: all reachable states (loading, empty, error, partial, unauthorized), every action's visible outcome, required layout at mobile and desktop widths, keyboard and screen-reader access, error display | `specs/web/` | `spec-prompt-web.md` |
| Journeys | J01–J05 | Cross-domain flows end to end (buy → payout, seller → first sale, launch day, catalog sync → search, engagement loop): every async hand-off, its consistency deadline, and duplicate/out-of-order/catch-up/compensation behaviour | `specs/journeys/` | `spec-prompt-journey.md` |

Every spec folder gets five files:

| File | Contents |
|---|---|
| `spec.md` | intended behaviour: user stories, functional requirements, acceptance scenarios, assumptions (no implementation details) |
| `test-plan.md` | which test proves each scenario, at the lowest layer that can. Backend: API e2e, UI journey, unit. Web: Playwright journey, Vitest + React Testing Library, Playwright screenshot, or "proven by backend spec". Journeys: journey test, or "proven by capability" |
| `gaps.md` | what the code gets wrong or lacks versus the spec, plus debt-register rows and `check:table-ownership` lines (backend), missing endpoints and test tooling (web), and broken hand-offs (journeys) |
| `questions.md` | every default the agent chose instead of asking you |
| `checklists/requirements.md` | spec quality checklist |

**Not specified anywhere, on purpose:**
- Pixel-level styling. Layout *structure* and states are specified and screenshot-tested.
- UIs for backend features that have no page in `packages/web` today: auctions, launch events, live stream,
  feed, stories, onboarding, delivery tracking, and asset library. Those stay API-only, proven by their S
  specs. To build a UI for one, add a `W` row to `capabilities.tsv` before step 2.

### Run it

```bash
DRY_RUN=1 scripts/sdd/write-specs.sh S10 W03 J01   # read one rendered prompt of each kind
scripts/sdd/write-specs.sh S01 S10                 # pilot: two real backend specs; read them, tune spec-prompt.md
rm -rf specs/domains/S01-* specs/domains/S10-*     # only if you changed the template and want them redone
scripts/sdd/write-specs.sh                         # all 67 in order: S, then W, then J; skips existing specs
```

**Timing:** the pilot took about 12–15 minutes per spec, so all 67 take roughly 13–17 hours. The script is
built to run unattended:
- a spec counts as done only with all four files, and then gets a `.spec-done` marker;
- partial attempts are cleared and redone;
- failures (crashes, usage limits) are retried after 10, 30, 60 and 120 minutes, then recorded while the run
  moves on;
- re-running the same command resumes.

```bash
tmux new -s specs                                   # detach with Ctrl-b d, re-attach with: tmux attach -t specs
cd <repo root>
systemd-inhibit --what=sleep:idle --why="SDD spec run" \
  scripts/sdd/write-specs.sh 2>&1 | tee -a specs-run.log
```

**Decision policy:** the agents don't wait for answers. For a portfolio showcase they pick the most
production-grade option the notes and constitution support, even when it changes today's behaviour, and tag
those choices `[BREAKING]`.

Each spec also gets a `## Cross-capability contracts` section (**Provides** / **Requires**). Every new spec
first reads the ones already written, so later capabilities honour earlier consumers' needs or flag a
`[CONTRACT]` question. W and J specs read the S specs they build on, so they come last in the catalog. If you pilot a W or J spec
early, write the S specs it lists first. Filters work by ID or by domain column
(`scripts/sdd/write-specs.sh payments web journeys`). Each spec's log is `<spec folder>/.specify.log`.

## Step 3 — Review the defaults (optional)

Implementation accepts every default as written, so this step is optional. Do it only if you want to
veto a specific choice.

The agents couldn't ask questions, so they recorded their choices instead:

```bash
scripts/sdd/review-questions.sh            # [BREAKING] and [CONTRACT] defaults across all specs, grouped by capability
scripts/sdd/review-questions.sh --all      # also [LOCAL] ones
```

Each default is tagged:
- `[BREAKING]` changes behaviour that exists today (e.g. a status code or a token lifetime). Read all of these.
- `[CONTRACT]` decides an interface another capability provides or consumes. Read these too.
- `[LOCAL]` is internal to one capability. Skim.

Edit the lines you disagree with. Edited lines override `spec.md` during implementation (the implement
prompt says so). For a capability that needs real discussion, run `/speckit-clarify` on it interactively
after setting `.specify/feature.json` to its directory.

## Step 4 — Implement and fix, spec by spec

```bash
# Backend capabilities (S): real test stores for the e2e specs
docker compose -f docker-compose.test.yaml up -d

# Web (W) and journeys (J): also the local dev stack. The script checks GET $API_URL/health/ready before each W/J.
# each in its own terminal: infra-setup and dev-monolith keep running in the foreground
moon run infra-setup                              # dev stores (docker compose up), then schemas and topics
moon run dev-monolith                             # API + workers + projectors on http://localhost:8000 (watch mode)

COMMIT=1 scripts/sdd/implement-specs.sh            # all written specs, in catalog order; resumes where it stopped
```

You can run the S capabilities first with only the test stack (`scripts/sdd/implement-specs.sh` stops at the
first W if the dev stack is down), then start the dev stack and re-run to continue with W and J.

For each capability the script runs:

1. `/speckit-plan` → `/speckit-tasks`, which are test-first: every `test-plan.md` row's failing test
   comes before its code, and every `gaps.md` item gets a task.
2. `/speckit-analyze`. It stops if analyze reports anything CRITICAL.
3. `/speckit-implement`, red → green. Tests are never weakened. A spec that looks wrong is recorded in
   `questions.md` and the run stops.
   - **Web:** the agent works in `packages/web` (reading its Next.js docs first) and adds any backend
     endpoints the UI needs, following the constitution.
   - **Journeys:** the agent writes `packages/backend/test/journeys/<slug>.journey-spec.ts` and fixes broken
     hand-offs in the owning domains.
4. `/speckit-converge`, plus a second implement pass if converge appended tasks.
5. **The gate.** Every kind first runs the backend core: `tsc`, the unit suite, `check:module-graph` (one
   process per app), `check:model-registry`, and `check:boundaries`. Then:
   - **S:** that capability's backend e2e specs.
   - **W:** web `tsc`, Vitest (`pnpm --filter web test`), and the Playwright suite (`pnpm --filter web
     test:e2e`, which starts the web dev server itself).
   - **J:** `pnpm test:journeys` against the running monolith.

   Then the integrity checks (`gate_extras`), which exist because an agent can "pass" without being right:
   - **Scenario coverage** (`scripts/sdd/check-tests.py scenarios`): every row of `test-plan.md` that names a test
     must have a test whose title carries the capability and scenario ID, e.g. `it('S13 AS-12: …')`.
   - **Test integrity** (`check-tests.py integrity`): tests that exist at `HEAD` must not lose `it`/`expect`
     calls, be deleted, or gain `.skip`/`xit`/`.todo`.
   - **Lint ratchet:** files the capability changed are `eslint --fix`ed and must then be clean (old debt elsewhere
     does not block).
   - **Ownership ratchet:** a backend capability must not add `check:table-ownership` findings in its domain
     (baseline recorded in `.ownership.baseline` before the work starts).

   Every step is chained explicitly (`&&`, `|| return 1`): inside `if ! gate`, bash ignores `set -e`.
6. Marks the capability `.implemented` and, with `COMMIT=1`, commits it as `feat(<domain>): <id> …`.

When it stops, read the named `.log`, fix the problem (or edit `questions.md` / the spec), and re-run the
same command. Finished capabilities are skipped. Run a single capability with
`scripts/sdd/implement-specs.sh S13`.

**Running until the plan runs out.** Leave `STEP_MAX_BUDGET_USD` unset to run until your Claude usage limit. A step that
dies on the limit stops the run with exit code 75 and a desktop notification plus sound ("out of budget"); finishing or
any other stop gets its own notification. Nothing is lost: re-run the same command after the reset. `implement` runs in
fresh-context passes (`MAX_IMPLEMENT_PASSES`, default 10) until every task in `tasks.md` is checked. The headless steps
do not trigger the interactive Stop-hook ping (`SDD_LOOP=1`).

**Self-repair: a failure inside one capability does not end the run.** A failed analysis (a CRITICAL finding), a stuck implement
pass, a failed gate or a crashed step goes to a separate *repair agent* (fresh context, `doctor-N.log`), which gets a time budget
(`REPAIR_BUDGET_MIN`, default 60 minutes for the whole run; at most `MAX_REPAIRS_PER_SPEC`, default 3, attempts of up to 25 minutes
per capability). It diagnoses the cause, fixes it (it may decide a contradiction and record it in `questions.md`, but never weakens
a test or a requirement) and the capability is retried. A crashed step is also retried once by itself. If the agent answers
`DOCTOR: needs human: <why>` or the budget is gone, the capability is **blocked**: `BLOCKED.md` in its spec folder says why, the
loop commits it, notifies you, and goes on to the next capability that does not depend on it (dependents are skipped too). The run
then ends with exit code 78 ("finished, but some capabilities are blocked"). A blocked capability is skipped on later runs until you
fix the cause and delete its `BLOCKED.md` (or set `RETRY_BLOCKED=1`).

**A failing gate is handed back to the agent.** When the gate fails, the loop gives the agent a digest of the failure (failing
tests, compiler or lint errors, scenarios without a test) and lets it repair the cause, then runs the gate again. At most
`MAX_GATE_REPAIRS` (default 5) attempts; after that the run stops with "gate failed". The agent may not weaken, skip or delete a
test; a failure outside the capability's own files is still fixed and noted under "Gate repairs" in the spec's `gaps.md`.

Gate speed (quality unchanged): the backend core gate (tsc, unit suites, module graph, model registry, boundaries) is skipped when
`packages/backend`, `packages/contracts` and the lockfile are byte-identical to the last time it passed in this checkout (fingerprint in
`.git/sdd-core-gate-ok`). After a failed web gate, the Playwright tests that failed run first (`--last-failed`, seconds); the full suite
must still pass before a spec is done. `PW_WORKERS` sets the Playwright workers (the VM uses 3; the config default is 2).

**Unattended runs.** `RUN_DEADLINE=<epoch seconds>` ends the whole run (no call starts after it, none outlives it): exit 76
and a "time budget used" notification. A login failure exits 77. With `PUSH_BRANCH=<name>` every commit is pushed there. The
VPS runner (`scripts/vps/`) sets all of these; see `scripts/vps/README.md`.

**Order and spend.** Capabilities run in `scripts/sdd/orders/by-layer.txt` order (platform → identity → money chain →
resume-featured → …). `UNTIL=S16` stops after that capability; `STEP_MAX_BUDGET_USD=5` caps one step. Agents run
e2e specs through `scripts/sdd/test-spec.sh` (condensed output) and stop after 5 failed attempts at one test.

**After each green capability**, update its rows in `pattern-map.md` from `implemented` to `verified`.

## Step 5 — Exploratory testing per client

Once everything is green:

```text
Explore packages/web against the running stack as a buyer, then as a seller, then as an admin, with Playwright (or Claude in Chrome), at mobile and desktop widths. Hunt for state-sync bugs, race conditions, session hand-off problems, and layout breaks. For each finding, add a failing test at the LOWEST layer that reproduces it (API e2e first; a UI journey, component test, or screenshot only if the bug is UI-specific, constitution VII.7), then fix it, and note the capability ID (S, W, or J) it belongs to.
```

---

## Headless permissions

Both scripts run `claude -p` with `--permission-mode acceptEdits`, `--add-dir interview-prep`,
and an explicit tool allowlist:

- Spec writing gets file tools plus `.specify/scripts` (see `scripts/sdd/lib.sh`).
- Implementation adds `npx tsc / jest / nest build / vitest / playwright`, `pnpm`, `node`, `docker compose`,
  and `curl` (readiness checks).

If a step stops on a permission error, extend the list in `lib.sh` or `implement-specs.sh`, or override
everything with `CLAUDE_ARGS="..."`.

## Known problem: the backend e2e sweep runs in batches (memory)

The checkpoint's regression sweep (`scripts/sdd/checkpoint.sh`) used to run every backend e2e suite (201 files) in one Jest process
(`--runInBand`). That process grew to the default 4 GB heap after about 16 minutes: the garbage collector then paused for seconds, so
the late suites saw 503s from load shedding, dropped database connections and impossible timer values, and the process finally aborted
("JavaScript heap out of memory"). A sweep reached only 67 of 201 suites, and the two suites that failed (`auth-register`, `topic-replay`)
passed alone, in pairs and in a batched run.

Fix: the sweep runs the suites in batches of `SWEEP_BATCH` (12), each batch in a fresh process, with `--max-old-space-size=6144` as margin
(a full sweep takes about 15 minutes). A batch that ends without its "Test Suites:" summary counts as a crash and fails the checkpoint.
`scripts/sdd/sweep-verdict.py` lists failing suites of domains with no built capability as "not counted" (old tests of features that are still
to be rebuilt); everything else counts.

Why memory grows is not found yet. Suspects: Jest's ES-module mode (`--experimental-vm-modules`) keeps loaded modules of finished suites alive,
and some suites leave Kafka clients or Nest apps open (the log shows `MaxListenersExceededWarning` for sockets). To find the biggest growers:
run one batch with `--logHeapUsage` and rank the suites by heap added.

## Known problem: web tests that depend on shared state

Browser tests run in parallel against one shared dev stack. Three kinds of state made them pass on a fresh stack and fail on re-runs
(the repair loop re-runs the gate on the same stack): inventory (every order-placing test reserved the same seeded product; they now create a
product with their own stock), the trending ranking (events recorded by other tests; the product-page layout test now uses a product in a
category of its own), and a warm search history or catalogue size (suggestion casing, a second results page). Rule: a test that needs a known
state creates its own data through the real API (`createIsolatedProduct` in `packages/web/tests/helpers.ts`), and never relies on what ran before.

## Harness roadmap

What turns the setup from "it works for me" into evidence a reader can check. The first three are the claims a description of this setup would make that the
repository does not yet back; build them before anything else. Estimates are working time, not elapsed time, and include tests.

1. **Role separation: a QA agent.** Today there is a builder and a repair agent. Add a separate agent with a fresh context that uses the running product like a
   person at every checkpoint (browser, console, network, API log, database), files each defect with its evidence, and hands them to the repair agent (follow-up 1
   below). About 3 to 4 hours, the one uncertain estimate (the benchmark and prompt tuning are most of it).
2. **Persistent learning from detected failures.** Today a person (and I) add rules after an incident. Add `docs/lessons.md`: every incident and every repair that
   needed a human appends a lesson (symptom, cause, the rule or check that prevents it); the agents' prompts include it; a script lists lessons with no check
   behind them. Measure repeats ("the same class of failure twice"). About 45 minutes (the file is already seeded).
3. **Measurable delivery.** Per run and per capability: tasks closed per pass, repairs, gates that passed after a repair that changed no code (flakes),
   failures found only by hand, time and quota. Written to a report (`run-report.md`) and a trend page. This is also the baseline for changing a prompt and seeing
   whether it helped. About 60 to 90 minutes.

Then, in order of payoff:

4. Repair agent for a failed checkpoint (follow-up 1 below), the flake signal (2), the unstubbed buy flow and the journey that must end in "Order confirmed",
   the infrastructure doctor with a readiness check that fails loudly. About 2.5 to 3.5 hours together.
5. Mutation testing on the money and identity code, so "every scenario's test can fail" is measured. Built as `scripts/mutation/mutate.py` and `changed.sh` (2026-10-13, in-house); still to do: run it on the money and identity code and fix the survivors.
6. The memory growth in the backend e2e suites (follow-up 3), the unexplained browser flakes (follow-up 4). About 2 to 4 hours.

Total: roughly 10 to 14 hours of work (the scripts of the living specification, the same kind of work, took about an hour). Items 1 to 3 are about 5 to 6 hours and carry most of the value. More tooling after that has little
value compared with one shipped product and a short write-up with real numbers.

## Metrics

What the loop measures, so that a change to a prompt or a limit can be judged by numbers and not by feel.

- **The log:** `.sdd-metrics/steps.jsonl`, one JSON line per step, appended by `metric_step` in `scripts/sdd/lib.sh`. Fields: `run` (one id per start of
  `implement-specs.sh`), `capability` (`S13`; `checkpoint:<label>` for a checkpoint; `-` for the run itself), `step`, `start`, `end`, `seconds`, `result`,
  `attempt`, `reason`, and on some lines `code_changed` (a repair step: did it change any file under `packages/` or `scripts/`) and `flake` (a gate or checkpoint that passed after repairs that changed no code).
- **Steps recorded:** `run-start` (with the commit and the limits in force: `MAX_GATE_REPAIRS`, `MAX_REPAIRS_PER_SPEC`, `REPAIR_BUDGET_MIN`, `MAX_IMPLEMENT_PASSES`),
  every Claude call (`plan`, `tasks`, `analyze`, `implement-N`, `converge-N`, `repair-N`, `doctor-N`, `ckrepair-<label>-N`), every `gate` and `checkpoint` attempt,
  `built`, `blocked`, and `intervention`. Steps skipped because they were done earlier are not recorded. A metrics failure never stops the loop.
- **Interventions:** `scripts/sdd/note-intervention.sh "found by hand: payment stays PENDING" S48` (the capability is optional). Start the text with
  `found by hand:` for a defect that no automated check found; the report counts those separately.
- **The report:** `python3 scripts/sdd/report.py` writes `docs/reports/<date>.md`: per capability the implement passes, repairs (and how many changed no code), gate failures, flakes,
  interventions and elapsed time; per checkpoint the failures, repairs and flakes; the interventions; and the trend over runs, with the latest run compared with the one before
  and any change of the limits shown ("settings changed since the previous run: MAX_GATE_REPAIRS 3 -> 5"). Read it at the start of a session.
- **A flake** is a gate (or checkpoint) that failed, was given to the repair agent, and passed while the code was byte-identical to the code at the first failure. The loop
  then writes the failing test names under "Flaky tests" in the spec's `gaps.md` (for a checkpoint: `specs/.checkpoints/<label>.flakes.md`), adds them to the final notification, and
  sets `"flake":true` on the metrics line. The report also derives a flake from the order of the lines when a log has none.
- **Is `.sdd-metrics` in `.gitignore`? No, on purpose.** The log is the only record of what a run did, and the runs that matter most happen on the cloud machine or the VPS
  runner, which is deleted when the run ends; only what the loop commits and pushes survives. With `COMMIT=1` the log is committed with each capability, so the data comes back
  with the branch. The costs: one short line per step (about 30 lines per capability) in the diffs, and two machines can append to the same file; `.gitattributes` sets
  `merge=union` for `.sdd-metrics/*.jsonl`, so merging keeps the lines of both sides and never conflicts (checked on a throwaway repository). If the noise bothers you, add
  `.sdd-metrics/` to `.gitignore` next to `.sdd-monitor/`; then the runner must copy the file back itself, which `scripts/vps/` does not do yet.
- **Not recorded yet:** the runner's machine type, hours and peak memory, and tasks closed per pass (the loop only knows how many are open). The QA agent's hits and misses go into
  the same log once that agent exists.

## The infrastructure doctor (static half)

`python3 scripts/infra/doctor.py` lists every queue, topic, bucket and table that the backend code names and checks each against what the local stack defines. It only
reads files: no Docker, no network. Exit 1 and a `MISSING` line (with the place that uses the item and the place that should define it) when something is not defined.

- **Queues:** names found in `packages/backend/libs` and `apps` (constants named like `*_QUEUE`, `queue: '...'`, `.enqueue/.consume('...')`, the notification queue map) against
  `infra/docker/elasticmq/elasticmq.conf`; every queue also needs its dead-letter queue (`<name>-dlq`, `<name>-dlq.fifo`); both compose files must mount the conf.
- **Topics:** `<aggregateType>.events` from `defineEvent(..., 'aggregate', ...)`, topic registrations and `aggregateType:` literals, plus literal topic strings, against
  `packages/backend/scripts/init-kafka-topics.sh` and `rpk topic create` lines (or topic auto-creation switched on in a compose file).
- **Buckets:** `*BUCKET*` values of the env examples (each against its own stack) and the default after `config.get('..bucket..') ??`, against the `mc mb` lines of the compose files.
- **Tables:** Postgres models (`tableName`) against `migrations/` (`createTable`, `CREATE TABLE`); DynamoDB tables against `dynamodb/*.json`; Cassandra tables against `cql/*.cql`.
- **Limits:** lexical, not a TypeScript parse. A name built at run time is invisible, so a clean run is not proof; a `MISSING` line is a lead to read. ClickHouse tables, the
  Terraform modules (`infra/modules`) and consumer-group topics are not covered. The dynamic half (the broker answers, the queue exists in the running ElasticMQ, `/health/ready`
  fails while a consumed queue is missing or an outbox row is parked) needs the stack and is not built.
- **Not wired into the gate or the checkpoint yet,** because it exits 1 on the real repository today (the topics below); wire it in when the topic question is settled.

What it finds on this repository (run on 2026-10-12, 142 items checked):
- queues: 40 checked, none missing. The three queues of lesson L-002 (`payments-charge`, `orders-refund-requested`, `tenancy-invite-requested`) and their dead-letter queues are defined.
  With `payments-charge` removed from a copy of the conf, the doctor names it and its dead-letter queue.
- buckets: 3 checked, none missing (`marketplace-media`, `marketplace-media-test`, and the code default `marketplace-media`).
- tables: 73 checked (Postgres models, DynamoDB, Cassandra), none missing.
- topics: 26 checked, 23 missing. Only `payments.dlq`, `payments.responses` and `products.events` are created by `init-kafka-topics.sh`. These are named by the code and created
  by nothing in the stack definitions: `analytics.events`, `api.events`, `auctions.events`, `billing.events`, `chat.events`, `courier.events`, `feed.events`, `identity.events`,
  `ledger.events`, `links.events`, `live.events`, `llm.events`, `marketing.events`, `media.events`, `orders.events`, `payments.events`, `pickup.events`, `search.events`,
  `shop.events`, `shops.events`, `stories.events`, `tenancy.events`, `usage.events`.
  I did not check this against a running broker. Redpanda does not create a topic on first use unless `auto_create_topics_enabled` is on, and neither compose file sets it, so on a
  fresh dev stack the first event of a missing topic may fail; if the stack works in practice, something creates the topics that this script cannot see, and the doctor should learn
  about it. One more lead: `tenancy/domain/events.ts:174` consumes `shop.events`, marked "provisional", while `seller-onboarding` registers `shops.events`; one of the two names may be wrong.
  Product code was not changed.

## Follow-ups for the build loop

Not built yet, in the order I would do them:

1. **Repair agent for a failed checkpoint.** A failing capability gate goes to the repair agent (bounded attempts, the `stack-fix.sh` tools, the
   failure digest); a failing checkpoint sweep does not: the loop stops with "checkpoint failed" and waits for a human. Hand the sweep's failing test
   names, Playwright's `error-context.md` snapshots and the log to a repair pass, then re-run the checkpoint, with the same attempt limit as a gate.
   **Built (overnight run, not yet run against a real failure):** `checkpoint_with_repair` in `scripts/sdd/checkpoint-repair.sh`, called by `implement-specs.sh` in place of
   `checkpoint.sh`. On a failure it builds a prompt from `scripts/sdd/failures.py digest` (failing suites and tests with their first assertion lines, Playwright failures,
   crashed batches, the `error-context.md` snapshots, the end of the log) and the lessons digest, runs a repair agent (`ckrepair-<label>-N`, fresh context, at most 25 minutes, inside
   the shared `REPAIR_BUDGET_MIN`), then runs the checkpoint again, at most `MAX_CHECKPOINT_REPAIRS` times (default `MAX_GATE_REPAIRS`). The agent ends with
   `CHECKPOINT-REPAIR: fixed`, `flake` or `needs human: <why>`; the last stops the run as before. Preview without running anything:
   `scripts/sdd/checkpoint-repair.sh --dry-run <label> [--log FILE]`. Not covered by tests: the real `claude` call and the real `checkpoint.sh` (they need the stack).
2. **Flake signal.** A gate that fails and then passes with a repair that changed no code is a flake, not a fix. Record the test names in the
   spec's `gaps.md` and in the final notification instead of counting it as a repair.
   **Built (overnight run):** see "Metrics" above for the rule and where it is recorded. The gate loop calls `gate_failed` and `gate_passed`; the checkpoint loop does the same.
3. **Find the memory growth in the backend e2e suites** (see "Known problem: the backend e2e sweep runs in batches"): `--logHeapUsage`, rank the
   suites by heap added, make the top ones close their Nest apps and Kafka/Redis clients.
4. **Occasional browser flakes seen once in ~550 runs** and not explained: `product-page` "focus order", `search` "no horizontal scroll at 320 px".
5. **The living spec** (docs of the current state, human-reviewed, signed with content hashes): its own SDD flow. A prototype of the sign-off
   tool exists uncommitted (`scripts/sdd/spec-guard.py`, with `specs/platform/G01-spec-governance/` drafted for the wrong target: it should govern
   the living pages, not the work-order specs).
6. **Queue registry check.** The local ElasticMQ configuration (`infra/docker/elasticmq/elasticmq.conf`) lacked three queues the code uses
   (`payments-charge`, `orders-refund-requested`, `tenancy-invite-requested`), so a payment stayed PENDING for ever on the dev stack (found by
   hand-testing; the browser tests stub the payment path). Add a static check that every queue name the code consumes or publishes is defined in
   that file, and run the payment journey once without stubs.
   **Static check built (overnight run):** `scripts/infra/doctor.py`, see "The infrastructure doctor (static half)". The payment journey without stubs is not.

## From "the gates pass" to "the product works"

What went wrong in the first full run (a memory crash in the sweep, a queue that did not exist, a payment that stayed PENDING, tests that only
passed on a warm stack) had one cause: nothing ran the real product end to end until late, and the tests that did were tolerant. Five changes,
in order of payoff:

1. **Define "done" as a flow, not a capability.** An unstubbed journey (register, add to cart, check out, pay, the order is PAID) must pass on a
   fresh stack and assert the outcome. Today `packages/web/tests/cart-checkout.spec.ts` (JC-2) accepts both "Payment is being processed…" and
   "Order confirmed"; make it require "Order confirmed", and keep "the page never claims success before the order is paid" as a separate test
   with a forced stuck state. Add `scripts/sdd/checkpoints/buy-ui.sh` (the checkpoint already runs such a script when it exists): an API-only
   walk of the same flow that waits up to 30 s for the order to be PAID. Run a cheap version of it after every few capabilities, not only at
   the end.
2. **A QA agent with a fresh context** that uses the running app like a person: it drives the browser, reads the console, the network calls, the
   API log and the database, and files each defect with the evidence. The defects go to the repair agent (see follow-up 1 above), then the
   checkpoint runs again. It is the step that would have found the stuck payment in minutes.
3. **Give agents eyes and tools, and make the system fail loudly.**
   - A "doctor" check that the infrastructure matches the code: every queue, topic, table and bucket the code uses is defined (the queue
     registry check from follow-up 6 is the first part).
   - The API must not report ready while a queue it consumes is missing or an outbox row is parked; today a missing queue was only a log line.
   - The repair agent gets the commands it needs behind one allowed script (`scripts/sdd/stack-fix.sh` has `smoke`, `browser`, `reindex`; add
     the ones that turn out to be missing).
4. **Rules against hollow tests.** No assertion that passes both when the feature works and when it does not ("A or B"). Every scenario's test
   must be able to fail: run it once against a deliberately broken implementation (mutation testing on the money and identity code is the
   systematic version). A test must never encode an environment limit as acceptable: report it as blocked.
5. **Always verify on a fresh stack, and keep the loop cheap to iterate.** A gate or sweep that only passes after earlier runs is not green.
   Keep a local "fresh stack, whole suite once" command (new compose project name, empty volumes), because a cloud attempt costs 30 to 40
   minutes.

On "harnesses": the loop's weak points were all in the harness (what the agent can see and run, what counts as passing, what happens on a failed
checkpoint), not in the model. Measure the loop before changing it: tasks closed per pass, repairs per capability, gates passed after a repair
that changed no code, failures found only by hand.

## The living specification in the loop

`docs/spec/` (see its README) says what the system does today. The loop treats it like this:
- **Gate:** `scripts/livespec/check.py` runs in `gate_extras` of every capability (broken proofs, code references, routes, links, models or a changed signed
  item fail the gate; a page whose code changed without the page, and style, only warn), and `check.py --guard` fails a run that touched a `.reviewed.json`.
- **A built capability gets a draft page** by itself (`generate.py --only <id>`, only when no page exists yet). After that the page is authored: an agent that
  changes behavior edits the page first (rule 0 of the agents' cross-spec rules).
- **Checkpoint:** the same checks, the state machines, the unit tests of the scripts and the Quint models, plus the code-versus-page warning against
  `origin/master`.
- Agents may run `check.py` and `models.py`; they cannot run `sign.py`.

