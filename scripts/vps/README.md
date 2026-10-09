# Running the SDD loop on a Hetzner VPS

A fresh machine is created for each run from a prepared image. It builds the next capabilities with the loop, commits and
pushes everything to a branch (`sdd/auto`), sends phone notifications, and **deletes itself**. You close the laptop, get a
message when it is done, pull the branch and test on localhost.

```
laptop                                                    Hetzner machine (CCX33: 8 dedicated vCPU, 32 GB), lives for one run
scripts/vps/run-remote.sh --until S53   ──creates──►     checks out sdd/auto, installs, starts the test stack (9 containers)
   then you close the lid                                 runs scripts/sdd/implement-specs.sh with a deadline, monitor beside it
phone: ntfy messages at 25/50/75 % and problems  ◄─────  commits per capability, pushes sdd/auto after every commit
laptop: git fetch && git checkout sdd/auto  ◄──────────  final push, notification, then the machine deletes itself
```

What stops a run: the work is done (`--until`), the order reaches a **checkpoint** (`!STOP` line), the **time budget** ends
(`--hours`), the Claude **usage limit** is hit, the Claude **login** fails, or something breaks. Every one of these pushes
what exists and sends a different notification. After a *failure* the machine stays `FAILURE_KEEP_MIN` minutes (default
120) so you can look around over ssh; after every other ending it deletes itself right after the push.

Status: written and rehearsed on a laptop with fake `claude` and `hcloud` programs (branch handling, push, exit paths,
notifications, deadline, login failure). **Not yet run against a real Hetzner account**; the first real run is the test of
the `hcloud` calls, the cloud-init step and the image build. Read "If something goes wrong" before leaving it unattended.

## One-time setup (about 45 minutes, most of it waiting)

Do these in order. Everything you create lives in a project that holds only runner machines.

1. **Hetzner account and project.** Sign up at hetzner.com/cloud (they may ask for an ID check; it can take a day, so do
   this first). Create a project, e.g. `sdd-runner`.
   - *Security -> API tokens -> Generate*: permission **Read & Write**. Copy it once; it goes into the config file. The
     machine carries this token to delete itself, which is why the project must hold nothing else.
   - *Security -> SSH keys -> Add*: upload `~/.ssh/id_ed25519.pub` (or create one) and name it `sdd`.
   - *Firewalls* (optional but good): create `sdd-ssh-only` allowing inbound TCP 22 and nothing else, put the name in the config.
   - Check the machine type exists where you want it: `hcloud server-type describe ccx33` and the locations list. If your
     account has a server limit of 0 for dedicated vCPU, ask for an increase in *Limits* (this can take a day too).
2. **hcloud CLI on the laptop.** Download from github.com/hetznercloud/cli/releases (or your package manager), then
   `hcloud context create sdd-runner` and paste the token. Check: `hcloud server list` (empty list is fine).
3. **A deploy key for the repo.**
   ```
   ssh-keygen -t ed25519 -N "" -f ~/.ssh/sdd_deploy
   ```
   GitHub -> repo *Settings -> Deploy keys -> Add deploy key*: paste `~/.ssh/sdd_deploy.pub`, tick **Allow write access**.
   Also protect `master` (*Settings -> Branches*, include administrators) so this key can never change it; the runner only
   writes `sdd/auto`.
4. **A Claude token for headless use.** On the laptop, signed in to the account you want to spend:
   ```
   claude setup-token
   ```
   Copy the token it prints (valid one year). Do **not** set `ANTHROPIC_API_KEY` anywhere for the runner: it would
   override the subscription and bill the API per token.
5. **Phone notifications.** Install the ntfy app, subscribe to a long random topic (e.g. `sdd-` plus 20 random characters;
   the topic name is the only secret), then test: `curl -d "hello" https://ntfy.sh/<your-topic>` should pop up on the phone.
   Optional: create a check at healthchecks.io and put its ping URL in `HEARTBEAT_URL`; it alerts you if the machine goes
   silent (covers a machine that died completely).
6. **The config file** (outside the repo):
   ```
   mkdir -p ~/.config/sdd-vps && cp scripts/vps/config.example.env ~/.config/sdd-vps/config.env && chmod 600 ~/.config/sdd-vps/config.env
   $EDITOR ~/.config/sdd-vps/config.env
   ```
7. **Push the repo.** The machine can only see what is on GitHub: `git push origin master`. `run-remote.sh` refuses to start
   if your local commits are not pushed.
8. **Build the image once** (15-25 minutes, a few cents): `scripts/vps/build-snapshot.sh`. It creates a temporary machine,
   installs Docker, Node 24, pnpm, the Claude Code CLI and the hcloud CLI, clones the repo, installs dependencies, pulls and
   builds the test-stack images, takes a snapshot and deletes the temporary machine. The snapshot id is saved in
   `~/.config/sdd-vps/snapshot-id`. Rebuild it (same command) when dependencies or the compose files change a lot; for
   small changes the runner just pulls the newest code at start. Add `--with-web` when you want the front-end specs
   (installs Playwright's Chromium and pulls the dev stack images).

Check the plan without spending anything: `scripts/vps/build-snapshot.sh` and `scripts/vps/run-remote.sh --until S53` both
accept `--dry-run` (build-snapshot via `DRY_RUN=1`) and print what they would do with secrets masked.

## Starting a run

```
scripts/vps/run-remote.sh --until S53 --hours 4
```
Options: `--until ID` stop after that capability (`S01:P1` works too), `--order NAME` (default `by-flow`), `--hours N`,
`--keep` (never delete the machine; you must), `--force` (start even if a runner exists), `--dry-run`. IDs after the
options restrict the run to those capabilities. Without `--until` the run goes to the next checkpoint.

The first phone message ("SDD runner created") arrives immediately; "SDD runner working" arrives 5-10 minutes later, once
the stack is up and the login check passed. Then you get 25/50/75 % milestones, and warnings (stalled, a task running
long, disk, a test container exited) each followed by a quiet "recovered" message. Watch live with `scripts/vps/attach.sh`
(tmux with the loop, monitor and stack logs; `Ctrl-b d` leaves it running).

Rough timeline for one big capability like S53: boot 1-2 min, setup 5-10 min, plan + tasks + analyze 10-20 min,
implement 1-3 h in several fresh-context passes, gate 5-10 min, push. The Claude usage limit is the real cap; the time
budget (`--hours`) is the hard stop.

## When it ends

| Message | What happened | What to do |
| --- | --- | --- |
| "SDD loop: finished" / "checkpoint reached" + "SDD runner done" | work done or checkpoint passed; pushed; machine deleted | `git fetch origin && git checkout sdd/auto`, test on localhost |
| "SDD loop: time budget used" | `--hours` ran out; everything committed is pushed | start another run: it resumes `sdd/auto` |
| "SDD loop: out of budget" | Claude usage limit; the reset time is in the message | start another run after the reset |
| "SDD loop: Claude login failed" | the token expired or is wrong | `claude setup-token`, update the config, run again |
| "SDD runner FAILED" | setup problem or the loop failed | the machine stays 2 h: `scripts/vps/attach.sh`; logs in `/var/log/sdd/` |

To test locally after a run: `git fetch origin && git checkout sdd/auto`, then the usual `moon run infra-setup` and
`moon run dev-monolith` (and `dev-web` for the browser). To continue on the VPS just run `run-remote.sh` again: it resumes
`sdd/auto` and merges `master` into it first, so tooling fixes you pushed to `master` arrive on their own. To restart from
`master` instead, delete the branch: `git push origin --delete sdd/auto`.

## Safety nets and cost

- Time: `RUN_DEADLINE` stops the loop at `--hours`; a systemd timer on the machine deletes it `--hours + 1` hours after
  start no matter what; `scripts/vps/cleanup.sh` (run it by hand, or from cron) deletes runner machines older than 8 hours.
- Money: a CCX33 costs roughly $0.22-0.33 per hour (check Hetzner's current prices; they repriced in June 2026). A 4-hour
  run is about $1-1.5. Look at the Hetzner console after the first run to confirm no machine is left.
- Secrets live only in the config file on your laptop and, for the length of a run, in `/etc/sdd/env` on the machine
  (mode 600). The image contains none. The token on the machine can only manage servers of its own project.
- The runner writes only `sdd/auto`; with `master` protected it cannot change anything else in the repo.
- Claude usage is shared with your normal use: a long run can leave you rate-limited when you sit down.

## If something goes wrong

- *No message at all after 15 minutes*: `hcloud server list`; if the machine exists, `scripts/vps/attach.sh` or
  `ssh root@<ip> journalctl -u sdd-run`. Cloud-init output: `/var/log/cloud-init-output.log`.
- *"cannot check out" / fetch fails*: the deploy key is not on the repo with write access, or the repo URL is wrong.
- *Tests fail only on the machine*: compare memory (`free -h`, `docker stats`); 32 GB should fit both stacks (the test stack
  alone uses about 4.8 GiB), and `ccx43` has 64 GB. Elasticsearch needs `vm.max_map_count` (the image sets it).
- *A machine is left running*: `scripts/vps/cleanup.sh 0 --all`.
- *Kill a run*: `hcloud server delete <name>`. Pushed work stays on `sdd/auto`; unpushed work on the machine is lost.
- Not covered yet: the front-end flow (dev stack + Playwright) on the machine; build the image with `--with-web` and treat
  the first front-end run as a trial.
