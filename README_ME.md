# README_ME: full setup and developer guide

The short version for visitors is in [README.md](README.md). This file has everything else: the full local stack, ports, load tests, and the tooling I use to work on the repo.

Requirements: Node 24+, pnpm 12, Docker.

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

Full unattended run (after the pilot; details in [`docs/architecture/sdd-runbook.md`](docs/architecture/sdd-runbook.md)):

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
- A failing gate is given back to the agent to repair (`MAX_GATE_REPAIRS`, default 2) before the run stops.
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
[`docs/architecture/vps-runner-plan.md`](docs/architecture/vps-runner-plan.md). In short, after the one-time setup:

```bash
git push origin master                           # the machine only sees what is on GitHub
scripts/vps/build-snapshot.sh                    # once: the runner image
scripts/vps/run-remote.sh --until S53 --hours 4  # one capability; close the laptop and wait for the phone message
git fetch origin && git checkout sdd/auto        # afterwards: test on localhost
```

Loop settings the runner uses: `RUN_DEADLINE` (epoch seconds, hard end; the loop exits 76), `PUSH_BRANCH` (push after every
commit), exit codes 75 (usage limit), 76 (time budget), 77 (Claude login failed).

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
| `docs/architecture/`, `docs/runbooks/`, `specs/` | you / the SDD scripts | Hand-written or agent-written, committed.                                                   |

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
[`docs/architecture/sdd-runbook.md`](docs/architecture/sdd-runbook.md).

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
