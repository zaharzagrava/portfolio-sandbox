# Plan: unattended SDD runner on a VPS

Status: plan only, nothing built. Written while S54 was the first spec running locally. Prices and account-terms
facts below come from web searches in October 2026 and must be re-checked on the provider's own pages before buying.

## Goal

Run `scripts/sdd/implement-specs.sh` for up to 5 hours at a time on a rented machine (night, or a day block), without
the laptop. The machine exists only while the run does. It stops by itself when the work is done, when the time budget
is used, or when something is wrong, and it tells the owner which of those happened.

Non-goals: parallel agents (tokens, not wall-clock, are the constraint), running on `master`, running the dev stack
for the web and journey specs (those come later, once the backend specs are green).

## Decision: ephemeral VM from a snapshot

| Option | Verdict |
| --- | --- |
| Always-on VM, monthly | Wasteful. 5 h/night is about 150 h/month; a 32 GB machine costs far more per month than for those hours |
| Hourly VM, create per run from a snapshot, delete after | **Chosen.** Pay only for the run; the snapshot makes start-up about 3 minutes instead of 30 |
| Power the VM off between runs | Do not. Hetzner (and most providers) keep billing a stopped server until it is deleted |
| Hosted sandbox (Anthropic cloud sessions) | Unlikely to fit: the e2e tests need Docker with ~16 GB for Elasticsearch, ClickHouse, Scylla, Redpanda, Postgres |

### Provider: Hetzner Cloud, dedicated-vCPU `CCX33` (8 vCPU, 32 GB RAM), x86

- Hourly billing with a monthly cap, per-second API, `hcloud` CLI, snapshots, cloud-init. Region does not matter
  (the run is not latency-sensitive); pick the cheapest of Falkenstein, Nuremberg, Helsinki.
- Dedicated vCPU matters: Elasticsearch and Scylla behave badly on noisy shared CPUs, and flaky e2e tests make the
  agent chase problems that are not in the code.
- x86 on purpose: the compose file pulls images (`marketplace/postgres:18-postgis-pgvector`, ClickHouse, Scylla,
  Redpanda) that are best tested on amd64. Do not pick the ARM `CAX` line.
- Price check needed. Hetzner re-priced its cloud on 2026-06-15. Third-party trackers disagree: roughly
  $0.22-0.33/hour for this size, about EUR 138/month before the cap. At 5 h a run that is about $1-2 per run,
  $30-60 for a month of nightly runs. A new account may need ID verification, and dedicated-vCPU plans may need a
  limit increase; do this first because it can take a day.
- Fallbacks if Hetzner will not onboard you: Vultr `voc-g-8c-32gb` (about $0.33/h) or Linode `g6-standard-8`
  (about $0.29/h). Same design; only the CLI differs.
- Monthly billing only makes sense above roughly 600 run-hours a month. It does not here.

## Architecture

```
laptop                                  Hetzner project "sdd-runner" (its own project, its own API token)
  run-remote.sh  --hcloud create-->     VM from snapshot "sdd-base-vN"  (cloud-init user_data carries the secrets)
   (or a button/alias)                    └─ /opt/sdd/run.sh
                                              1. preflight  (claude ok, docker, disk, git clean)
                                              2. moon run infra-test-setup  (stack up + migrations)
                                              3. scripts/sdd/implement-specs.sh   (deadline, watchdog, wait-for-reset)
                                              4. push branch sdd/auto, write run-report.md
                                              5. notify (ntfy)  → hcloud server delete self
```

### The snapshot (`sdd-base-vN`), built once and rebuilt when the stack changes

- Ubuntu LTS, Docker + compose plugin, Node 24, pnpm 12, moon, Claude Code CLI, tmux, `hcloud`, `jq`, `gh` optional.
- Repo cloned at `/opt/sdd/repo`, `pnpm install` done, `docker compose -f docker-compose.test.yaml pull` done
  (images baked in), `packages/backend/.env.test` in place.
- No secrets in the snapshot.

### Secrets (passed through cloud-init `user_data` at create time, from a local file that is never committed)

| Secret | Purpose | Scope |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | from `claude setup-token` (one year) | model requests only. Do **not** set `ANTHROPIC_API_KEY` on the VM: it overrides the subscription and bills the API |
| Git deploy key (write) | push the `sdd/auto` branch | one repo. **Protect `master`** (including admins) so this key cannot touch it |
| `HCLOUD_TOKEN` | the VM deletes itself | token from a dedicated Hetzner *project* that contains only runner VMs |
| ntfy topic | notifications | random, hard to guess topic name |

Never copy `~/workspace/notes/AI/.env` (Short.io, Bitly tokens) or any resume material to the VM.

## Guardrails (what to build in `scripts/sdd`)

1. **Run deadline.** `RUN_DEADLINE` (epoch seconds, default start + 5 h). Checked before every step; every `claude`
   call is wrapped in `timeout` for `min(PASS_TIMEOUT, time left)`.
2. **Per-pass timeout**, default 105 minutes. A killed pass is not a failure: the next pass is a fresh context that
   resumes at the first unticked task (the loop already does this).
3. **Stall watchdog.** No `tasks.md` tick and no changed file for 25 minutes kills the pass. Catches a hung agent
   far earlier than the timeout.
4. **Pass and spec caps.** Keep `MAX_IMPLEMENT_PASSES`; add `MAX_SPECS` for trial runs.
5. **Wait for the limit reset.** On a usage-limit stop, parse `resets 1:40pm (Europe/Warsaw)` (the CLI prints it;
   `limit_reset_hint` already extracts it), sleep until then plus a few minutes if that is before the deadline,
   then continue. Otherwise exit 75.
6. **Auth failure is its own state.** A 401 or expired token produces a distinct notification, not a generic FAIL.
7. **Remote notifications and monitoring (built, `scripts/sdd/monitor.sh` + `notify` in `lib.sh`).** `notify` has
   quiet (`info`), soft-sound (`warn`) and end-of-run kinds, with desktop and ntfy channels (`NTFY_TOPIC`). The
   monitor runs next to the loop as its own process (a second systemd unit or tmux pane on the VM): quiet 25/50/75/100 %
   milestones, warnings for a stalled run, one task open too long, the loop process gone, disk almost full and an
   exited test container, each followed by a quiet "recovered, it lasted N min" message, and a `HEARTBEAT_URL` ping
   every interval. On the VM, point `HEARTBEAT_URL` at a dead-man's-switch check (e.g. healthchecks.io) so that a VM
   that died completely, with its monitor, still produces an alert.
8. **Push after every green spec** (`PUSH_BRANCH=sdd/auto`), so a dead VM loses at most the spec in progress.
9. **Usage log** (`.usage.tsv`: spec, pass, start, end, tasks closed) plus `run-report.md` at the end: this is also
   how the real time and quota cost per spec finally gets measured.
10. **Self-destruct.** `run.sh` traps EXIT: push, notify, `hcloud server delete`. A second line of defence runs from
    the laptop: a nightly `hcloud server list` check that deletes runner VMs older than 7 hours.

There is no precise token cap on a subscription (`--max-budget-usd` measures API dollars). The effective caps are the
deadline, the pass limits, and the plan's own usage window.

## Safety

- The VM is disposable and holds no valuable secrets, which is better than running the agent on the laptop.
- The agent already runs with `acceptEdits` and an allow-list of Bash commands. Keep that list; do not widen it for
  the VM.
- Compounding errors are the main risk, not security. Review the first specs by hand: S54, S53, S49, S50, S52 form
  the platform layer everything else uses. Consider a separate fresh-context reviewer step for these before letting
  the loop run unattended across the other 60.
- Treat a green gate as necessary, not sufficient. Read the morning diff stat and skim the new tests.
- Quota: the run shares the Claude account's limits with the owner's interactive use. Prefer a night window.

## Phases

| Phase | What | Exit criterion |
| --- | --- | --- |
| 0 | Finish S54 locally and watch the gate; record time and quota per spec | One spec committed green; real cost known |
| 1 | Build the guardrails above and test them with a fake `claude` (as was done for the limit message) | Each guardrail has a scripted test; no tokens spent |
| 2 | Hetzner account, project, token, limit increase; build the snapshot; write `run-remote.sh` | `run-remote.sh --dry-run` creates and deletes a VM |
| 3 | Trial: `MAX_SPECS=2`, 2-hour deadline, watch it live over SSH | Branch pushed, report written, VM deleted, notification received |
| 4 | Nightly runs, 5-hour deadline | Morning routine below |
| 5 | Add the dev stack on the VM for W and J specs | Only after the backend specs are green |

## Morning routine

1. Read the notification (finished, out of budget, stalled, auth, failed).
2. Open `run-report.md` on the `sdd/auto` branch; check time and quota per spec.
3. Skim the diff stat and the new tests; open a PR to `master` for what is good.
4. Confirm in the Hetzner console that no runner VM is left.

## Open questions

- Account terms. Anthropic documents `claude -p` and `claude setup-token` for CI and headless use, and says CI runs
  draw on the subscription limits. Nothing found forbids a personal VPS, but the Consumer Terms were not read here.
- Whether Max's monthly API credits apply to `claude -p` (two support articles disagree). Check the usage page.
- Real per-spec cost, which decides how many specs fit in a 5-hour window (Phase 0).
- Scylla and Elasticsearch settings on a fresh VM (AIO limits, `vm.max_map_count`); expect to tune these in Phase 3.
