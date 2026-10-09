# Run the SDD loop on a Hetzner VPS

`scripts/vps/run-remote.sh` creates a machine for one run. It builds capabilities, commits and pushes branch `sdd/auto`,
messages your phone, and **deletes itself**. You close the laptop, get a message, then `git fetch && git checkout sdd/auto`
and test on localhost.

Status: rehearsed locally with fake `claude`/`hcloud`; **not yet run against a real Hetzner account**.

## Setup (once). Every value ends up in ONE file: `~/.config/sdd-vps/config.env`

That file is outside the repo and `chmod 600`. Create it with
`mkdir -p ~/.config/sdd-vps && cp scripts/vps/config.example.env ~/.config/sdd-vps/config.env && chmod 600 ~/.config/sdd-vps/config.env`,
open it with `nano ~/.config/sdd-vps/config.env`, and fill in the lines below. Never paste these values anywhere else.

1. **Hetzner token.** In the Hetzner console, open your project: *Security -> API tokens -> Generate API token*, permission
   **Read & Write**. Copy it and paste it into the config file after `HCLOUD_TOKEN=`.

2. **Your SSH key into Hetzner.** In the terminal run `cat ~/.ssh/id_ed25519.pub` and copy the one line it prints. In the
   Hetzner console: *Security -> SSH keys -> Add SSH key*. Paste that line into the key box and type `sdd` in the Name box.
   (`sdd` is only a label, not a file. The config already has `HCLOUD_SSH_KEY=sdd`; the two names must match.)

3. **A deploy key, so the machine can push to GitHub.** In the terminal:
   ```
   ssh-keygen -t ed25519 -N "" -f ~/.ssh/sdd_deploy
   cat ~/.ssh/sdd_deploy.pub
   ```
   The config already has `DEPLOY_KEY_FILE=~/.ssh/sdd_deploy`, nothing to edit.

4. **Give GitHub the deploy key.** Repo -> *Settings -> Deploy keys -> Add deploy key*. Paste the output of the `cat` from
   step 3 and tick **Allow write access**.

   Optional safety net, so the key can never touch `master`: *Settings -> Rules -> Rulesets -> New ruleset -> New branch
   ruleset*. Name `protect-master`, enforcement **Active**, bypass list: add the **Repository admin** role (that is you),
   target: the default branch, rules: **Restrict updates**, **Restrict deletions**, **Block force pushes**. Do not tick
   "Require a pull request" (it would block your own pushes). If you do not see Rules at all (private repo on the free plan),
   skip it: the runner script only pushes `sdd/auto`.

5. **Claude token.** In the terminal, signed in to the Claude account you want to spend, run `claude setup-token`. Copy the
   token it prints and paste it into the config after `CLAUDE_CODE_OAUTH_TOKEN=`.

6. **Phone notifications.** Install the ntfy app and subscribe to a long random topic you invent (for example `sdd-` plus 20
   random letters). Test it: `curl -d hi https://ntfy.sh/<your-topic>` should appear on the phone. Paste the topic name
   into the config after `NTFY_TOPIC=`.

7. **Push the repo.** `git push origin master`. The machine only sees what is on GitHub, and the launcher refuses to start if
   your local commits are not pushed.

Optional: `HCLOUD_FIREWALL=` (a Hetzner firewall that allows inbound port 22 only), `HEARTBEAT_URL=` (a healthchecks.io ping
URL that alerts you if the machine goes silent). Do not set `ANTHROPIC_API_KEY` anywhere: it would bill the API instead of
your subscription.

Two SSH keys, two jobs: step 2 is the key **you** use to log in to a machine; steps 3 and 4 are the key the **machine** uses
to push to GitHub. The file ending `.pub` is the only one you ever paste into a website.

`hcloud` (the Hetzner CLI) must be installed: `hcloud version`. If not: `sudo apt install hcloud-cli`, or the newer release
from github.com/hetznercloud/cli/releases (put the `hcloud` file in `~/.local/bin`). You do not need `hcloud context create`.

## Build the image (once, 15-25 min, a few cents)

```
scripts/vps/build-snapshot.sh
```
Creates a temporary machine, installs everything, bakes in the test-stack Docker images, takes a snapshot, deletes the
machine. Rebuild when dependencies or compose files change a lot (add `--with-web` for the front-end specs later).

## Run

```
scripts/vps/run-remote.sh --until S53 --hours 5      # add --dry-run first to see what it would do
```
Then close the laptop. `--until ID` stops after that capability; without it the run goes to the next checkpoint.
Watch live (optional): `scripts/vps/attach.sh` (Ctrl-b d to leave).

You get phone messages: *created* at once, *working* after 5-10 min (stack up, login checked), then 25/50/75 % and any
warning (stalled, task running long, disk, container exited), each warning followed by a quiet "recovered".

## When it ends

- *finished*, *checkpoint reached*, *SDD runner done*: the work is done or the checkpoint passed, everything is pushed and
  the machine is deleted. Run `git fetch origin && git checkout sdd/auto` and test on localhost.
- *time budget used*: `--hours` ran out; everything is pushed. Run again, it resumes `sdd/auto`.
- *out of budget*: the Claude usage limit (the reset time is in the message); pushed. Run again after the reset.
- *Claude login failed*: the token expired. Run `claude setup-token`, update the config, run again.
- *SDD runner FAILED*: a setup problem or a loop failure. The machine stays 2 hours: `scripts/vps/attach.sh`, logs in
  `/var/log/sdd/`.

A new run resumes from the newest of `sdd/auto` and the safety snapshot `sdd/wip` (a crashed run leaves the snapshot newer, with its
uncommitted work), and merges `master` into it first. To start over from `master`: `git push origin --delete sdd/auto`.

## Cost and safety

About $0.22-0.33 per machine-hour (check Hetzner's current prices): a 4-5 hour run is $1-2. The machine is deleted by the
script, by a timer on the machine (`--hours` + 1 h), or by `scripts/vps/cleanup.sh 0 --all` (run it by hand if in doubt;
check the Hetzner console after the first run). The token on the machine can only manage servers of its own project, so use
a project that holds nothing else. The runner writes only `sdd/auto`; protected `master` stays untouched.

## If something goes wrong

- No message after 15 min: `hcloud server list`, then `scripts/vps/attach.sh` or `ssh root@<ip> journalctl -u sdd-run`.
- Fetch/push fails: the deploy key is missing or lacks write access (steps 3-4).
- Tests fail only on the machine: check `free -h` and `docker stats`; `HCLOUD_SERVER_TYPE=ccx43` has 64 GB.
- Kill a run: `hcloud server delete <name>`. Pushed work stays on `sdd/auto`; the latest safety snapshot (every 15 minutes,
  uncommitted work included) is on branch `sdd/wip`. To recover after a crash: `git fetch origin && git checkout -B sdd/auto origin/sdd/wip && git push -f origin sdd/auto`.
- Not covered yet: the front-end flow (dev stack + Playwright) on the machine.
