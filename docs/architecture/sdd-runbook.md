# SDD Runbook: from refactor to verified domains

The order of work after the domain map and constitution v3.1.0. Run the steps in order, one at a time
(no parallel agents). Related files:

| File                                                                     | Role                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| [`domain-map.md`](domain-map.md)                                         | target domains and table ownership                                              |
| [`pattern-map.md`](pattern-map.md)                                       | every Interview-Prep pattern → where it lives → which capability spec proves it |
| [`debt-register.md`](debt-register.md)                                   | every open constitution violation (D-1…D-15) and what pays it                   |
| [`scripts/sdd/capabilities.tsv`](../../scripts/sdd/capabilities.tsv)     | 67 capabilities, one spec each, in execution order: 55 backend (S), 7 web (W), 5 journeys (J) |
| [`scripts/sdd/spec-prompt.md`](../../scripts/sdd/spec-prompt.md)         | the `/speckit-specify` prompt template (backend); `spec-prompt-web.md`, `spec-prompt-journey.md` for W and J |
| [`scripts/sdd/write-specs.sh`](../../scripts/sdd/write-specs.sh)         | step 2: writes all specs, headless, sequentially                                |
| [`scripts/sdd/implement-specs.sh`](../../scripts/sdd/implement-specs.sh) | step 4: plan → tasks → analyze → implement → converge → gate, per spec          |

---

## Step 1 — Finish the refactor

Paste each block into Claude Code as-is, in order. Each one ends with the same verification gate as
batch 3: `tsc` 0 errors, unit suite unchanged, `jest db/` 5/5, `pnpm check:module-graph` 9/9, all 9
apps build, 52 e2e specs listed, 0 deep `@app/domains/<d>/` imports.

### 1a. Batch 4 — social, discovery, insights (about 120 files)

```text
/speckit.plan Continue Phase 2 with Batch 4, using the same pipeline (phase2-batch4-moves.tsv → phase2-move.sh → phase2-entrypoints.ts). Read docs/architecture/domain-map.md and the constitution first.

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
/speckit.plan Continue Phase 2 with Batch 5, the last move batch, using the same pipeline (phase2-batch5-moves.tsv → phase2-move.sh → phase2-entrypoints.ts). Read docs/architecture/domain-map.md and the constitution first.

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

**Batch 5 is done ([specs/006](../../specs/006-phase2-batch5-domains/plan.md)), including D-13: `murmur3` moved to
`libs/common/core`. D-12 and every other open item now live in [`debt-register.md`](debt-register.md).**

### 1c. Phase 3 — cleanup and enforcement (not a move batch)

```text
/speckit.plan Execute Phase 3: retire libs/common/src and turn on boundary enforcement. Read docs/architecture/domain-map.md, the constitution, and docs/architecture/debt-register.md (rows D-1…D-5 and D-9 are this phase's; mark each `resolved (Phase 3)` when done).

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

**Phase 3 is done ([specs/007](../../specs/007-phase3-cleanup/plan.md)).** **Then commit.** Step 2 onward assumes a clean tree, and `implement-specs.sh` can commit per capability.

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

# Web (W) and journeys (J): also the local dev stack. The script checks GET $API_URL/readyz before each W/J.
# each in its own terminal: infra-up and dev-monolith keep running in the foreground
moon run :infra-up                                 # dev stores (docker compose up)
moon run :infra-setup                              # once the stores are up
moon run :dev-monolith                             # API + workers + projectors on http://localhost:8000 (watch mode)

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
6. Marks the capability `.implemented` and, with `COMMIT=1`, commits it as `feat(<domain>): <id> …`.

When it stops, read the named `.log`, fix the problem (or edit `questions.md` / the spec), and re-run the
same command. Finished capabilities are skipped. Run a single capability with
`scripts/sdd/implement-specs.sh S13`.

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
