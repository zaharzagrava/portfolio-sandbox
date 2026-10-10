#!/usr/bin/env bash
# Runs ON the runner machine (started by the user data that run-remote.sh wrote). It:
#   checks out the work branch -> installs -> starts the test stack -> starts the monitor -> runs the loop with a deadline
#   -> commits and pushes everything -> deletes the machine (after a failure it waits FAILURE_KEEP_MIN so you can ssh in).
# Settings come from /etc/sdd/env. Test switches: SDD_SKIP_STACK=1, SDD_DRY_DELETE=1, SDD_ENV_FILE=<other env file>.
set -uo pipefail
set -a; source "${SDD_ENV_FILE:-/etc/sdd/env}"; set +a
export HOME="${HOME:-/root}"
REPO="${SDD_REPO_DIR:-/opt/sdd/repo}"
LOG="${SDD_LOG_DIR:-/var/log/sdd}"
mkdir -p "$LOG"
exec > >(tee -a "$LOG/vm-run.log") 2>&1
cd "$REPO"
unset ANTHROPIC_API_KEY   # the subscription token must win

ts() { date +%H:%M:%S; }
say() { echo "[$(ts)] $*"; }
ntfy() { # title, body, priority(1-5), tag
  [[ -n "${NTFY_TOPIC:-}" ]] || return 0
  curl -fsS -m 10 -H "Title: $1" -H "Priority: ${3:-3}" -H "Tags: ${4:-robot}" -d "$2" "${NTFY_SERVER:-https://ntfy.sh}/$NTFY_TOPIC" >/dev/null 2>&1 || true
}

# the machine must never outlive its budget: a timer outside this script deletes it even if this script dies
BIN="${SDD_BIN_DIR:-/usr/local/bin}"
cat > "$BIN/sdd-destroy" <<'D'
#!/usr/bin/env bash
set -a; source "${SDD_ENV_FILE:-/etc/sdd/env}"; set +a
if [[ -n "${SDD_DRY_DELETE:-}" ]]; then echo "DRY DELETE server ${SERVER_ID:-?}"; exit 0; fi
exec hcloud server delete "$SERVER_ID"
D
chmod +x "$BIN/sdd-destroy"
if [[ -z "${SDD_DRY_DELETE:-}" ]]; then
  systemd-run --unit=sdd-hard-stop --on-active="$(( ${SDD_HOURS:-5} + 1 ))h" "$BIN/sdd-destroy" >/dev/null
fi

destroy_now() {
  if [[ -n "${SDD_KEEP:-}" ]]; then say "SDD_KEEP set: leaving the machine alone"; return; fi
  say "deleting this machine"; sleep 3; "$BIN/sdd-destroy"
}

fail_and_wait() { # a setup problem or an unexpected loop failure: keep the machine for a while so it can be inspected
  local why="$1" keep="${FAILURE_KEEP_MIN:-120}"
  say "FAILED: $why"
  ntfy "SDD runner FAILED" "$why. The machine stays for ${keep} min: ssh root@${SERVER_IP:-?} then 'tmux attach -t sdd' or read $LOG." 5 x
  if [[ -z "${SDD_KEEP:-}" && -z "${SDD_DRY_DELETE:-}" ]]; then systemd-run --unit=sdd-failure-stop --on-active="${keep}m" "$BIN/sdd-destroy" >/dev/null; fi
  exit 1
}

say "runner starting: order=$SDD_ORDER until=${SDD_UNTIL:-none} ids='${SDD_ARGS:-}' hours=$SDD_HOURS branch=$PUSH_BRANCH"

# --- git: work on PUSH_BRANCH (resume it if it exists on origin, else start from BASE_BRANCH), never on BASE_BRANCH
# identity through the environment, never through `git config --global`: that would overwrite the identity of whoever runs this
# script by hand (it happened once on a laptop while rehearsing)
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-SDD runner}" GIT_COMMITTER_NAME="${GIT_AUTHOR_NAME:-SDD runner}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-sdd-runner@users.noreply.github.com}" GIT_COMMITTER_EMAIL="${GIT_AUTHOR_EMAIL:-sdd-runner@users.noreply.github.com}"
git fetch -q origin || fail_and_wait "git fetch failed (deploy key?)"

# where to start: the newest of PUSH_BRANCH and the safety snapshot sdd/wip (a crashed run leaves the snapshot newer, with its
# uncommitted work); a branch that does not exist yet starts from BASE_BRANCH
pick_start_ref() {
  local auto="" wip="" wt at=0
  git rev-parse -q --verify "refs/remotes/origin/$PUSH_BRANCH" >/dev/null && auto="origin/$PUSH_BRANCH"
  git rev-parse -q --verify "refs/remotes/origin/sdd/wip" >/dev/null && wip="origin/sdd/wip"
  if [[ -n "$wip" ]]; then
    wt="$(git log -1 --format=%ct "$wip")"
    [[ -n "$auto" ]] && at="$(git log -1 --format=%ct "$auto")"
    (( wt > at )) && { echo "$wip"; return; }
  fi
  [[ -n "$auto" ]] && echo "$auto" || echo "origin/$BASE_BRANCH"
}
start_ref="$(pick_start_ref)"
git checkout -q -B "$PUSH_BRANCH" "$start_ref" || fail_and_wait "cannot check out $start_ref"
if [[ "$start_ref" != "origin/$BASE_BRANCH" ]]; then
  git merge -q --no-edit "origin/$BASE_BRANCH" || { git merge --abort; fail_and_wait "merging $BASE_BRANCH into $PUSH_BRANCH conflicts; merge it yourself and run again"; }
fi
say "starting from $start_ref ($(git rev-parse --short HEAD))"

# --- dependencies and the files git does not carry
pnpm install --frozen-lockfile --prefer-offline >"$LOG/install.log" 2>&1 || fail_and_wait "pnpm install failed (see $LOG/install.log)"
[[ -f packages/backend/.env.test ]] || cp packages/backend/env/test.env.example packages/backend/.env.test
if [[ ! -f packages/backend/creds/jwtRS256.key ]]; then
  mkdir -p packages/backend/creds
  openssl genrsa -out packages/backend/creds/jwtRS256.key 2048 2>/dev/null
  openssl rsa -in packages/backend/creds/jwtRS256.key -pubout -out packages/backend/creds/jwtRS256.key.pub 2>/dev/null
fi

# a fresh machine has no ~/.claude.json: mark onboarding done so the headless CLI never waits for an answer
[[ -f "$HOME/.claude.json" ]] || echo '{"hasCompletedOnboarding": true}' > "$HOME/.claude.json"

# --- is the Claude login good? (a few tokens; catches an expired token before the machine spends an hour on setup)
if ! timeout 180 claude -p "reply with the single word ok" --tools "" --no-session-persistence >"$LOG/claude-check.log" 2>&1; then
  fail_and_wait "Claude check failed: $(head -c 200 "$LOG/claude-check.log"). Make a new token with 'claude setup-token' and update the runner config"
fi

# --- the test stack
STACK_PID=""
if [[ -z "${SDD_SKIP_STACK:-}" ]]; then
  say "starting the test stack"
  scripts/infra/stack.sh test setup >"$LOG/stack.log" 2>&1 &
  STACK_PID=$!
  for _ in $(seq 1 240); do
    grep -q "stack is up and migrated" "$LOG/stack.log" 2>/dev/null && break
    kill -0 "$STACK_PID" 2>/dev/null || fail_and_wait "the test stack exited during start-up (see $LOG/stack.log)"
    sleep 5
  done
  grep -q "stack is up and migrated" "$LOG/stack.log" || fail_and_wait "the test stack did not come up in 20 minutes (see $LOG/stack.log)"
fi
# --- FE image: the dev stack, its migrations and the API (monolith) on :8000; Playwright starts Next.js itself
DEV_PID=""; API_PID=""
if [[ "${SDD_IMAGE:-be}" == fe && -z "${SDD_SKIP_STACK:-}" ]]; then
  say "starting the dev stack"
  bash scripts/infra/make-dev-env.sh >/dev/null
  scripts/infra/stack.sh dev setup >"$LOG/dev-stack.log" 2>&1 &
  DEV_PID=$!
  for _ in $(seq 1 360); do
    grep -q "dev stack is up and migrated" "$LOG/dev-stack.log" 2>/dev/null && break
    kill -0 "$DEV_PID" 2>/dev/null || fail_and_wait "the dev stack exited during start-up (see $LOG/dev-stack.log)"
    sleep 5
  done
  grep -q "dev stack is up and migrated" "$LOG/dev-stack.log" || fail_and_wait "the dev stack did not come up in 30 minutes (see $LOG/dev-stack.log)"
  say "starting the API"
  pnpm --filter api run start:dev:monolith >"$LOG/api.log" 2>&1 &
  API_PID=$!
  for _ in $(seq 1 120); do curl -sf http://localhost:8000/health/ready >/dev/null && break; kill -0 "$API_PID" 2>/dev/null || fail_and_wait "the API exited during start-up (see $LOG/api.log)"; sleep 5; done
  curl -sf http://localhost:8000/health/ready >/dev/null || fail_and_wait "the API did not become ready in 10 minutes (see $LOG/api.log)"
  say "dev stack and API ready"
fi
say "test stack ready; memory: $(free -h | awk 'NR==2{print $3" used of "$2}')"

# --- watch it from a tmux session (ssh in, 'tmux attach -t sdd'), monitor in the background
export ORDER="$SDD_ORDER" COMMIT=1 PUSH_BRANCH PASS_TIMEOUT_S NTFY_TOPIC NTFY_SERVER HEARTBEAT_URL
[[ -n "${SDD_UNTIL:-}" ]] && export UNTIL="$SDD_UNTIL"
export RUN_DEADLINE=$(( $(date +%s) + SDD_HOURS * 3600 ))
# shellcheck disable=SC2086
scripts/sdd/monitor.sh ${SDD_ARGS:-} >"$LOG/monitor.out" 2>&1 &
MON_PID=$!
if command -v tmux >/dev/null; then
  tmux kill-session -t sdd 2>/dev/null || true
  tmux new-session -d -s sdd -n loop "tail -F $LOG/loop.log"
  tmux new-window -t sdd -n monitor "tail -F $REPO/.sdd-monitor/progress.log"
  tmux new-window -t sdd -n stack "tail -F $LOG/stack.log"
fi
ntfy "SDD runner working" "Stack is up, starting the loop (order $SDD_ORDER, until ${SDD_UNTIL:-the next checkpoint}, deadline in ${SDD_HOURS}h)." 3 hammer_and_wrench

# --- rolling safety snapshot: every SNAPSHOT_MIN minutes the whole working tree (including uncommitted work) is pushed to the
# branch sdd/wip. It uses a temporary git index and commit-tree, so it never touches the real index, the loop's commits or
# sdd/auto. If this machine dies, the latest state is on GitHub.
snapshot_loop() {
  local every="${SDD_SNAPSHOT_SECONDS:-$(( ${SNAPSHOT_MIN:-15} * 60 ))}" last="" idx tree c
  while sleep "$every"; do
    idx="$(mktemp)"; cp "$(git rev-parse --git-dir)/index" "$idx" 2>/dev/null
    tree="$(GIT_INDEX_FILE="$idx" git add -A >/dev/null 2>&1 && GIT_INDEX_FILE="$idx" git write-tree 2>/dev/null)"
    rm -f "$idx"
    [[ -n "$tree" && "$tree" != "$last" ]] || continue
    c="$(git commit-tree "$tree" -p HEAD -m "wip(sdd) snapshot $(date -u +%FT%TZ)")" || continue
    if git push -q -f origin "$c:refs/heads/sdd/wip" 2>/dev/null; then last="$tree"; say "snapshot pushed to sdd/wip ($(git rev-parse --short "$c"))"; fi
  done
}
snapshot_loop &
SNAP_PID=$!

# peak memory use of the whole run, to size the machine (sampled every 20 s; the final message reports it)
( peak=0; while sleep 20; do used="$(free -m | awk 'NR==2{print $3}')"; (( used > peak )) && { peak=$used; echo "$peak" > "$LOG/peak-mem-mb"; }; done ) &
MEM_PID=$!

# --- the loop
say "loop starting"
# shellcheck disable=SC2086
scripts/sdd/implement-specs.sh ${SDD_ARGS:-} >"$LOG/loop.log" 2>&1
code=$?
say "loop ended with exit code $code"

kill "$MON_PID" "$SNAP_PID" "$MEM_PID" ${API_PID:+"$API_PID"} 2>/dev/null || true
say "peak memory used during the run: $(cat "$LOG/peak-mem-mb" 2>/dev/null || echo ?) MB of $(free -m | awk 'NR==2{print $2}') MB (machine type: ${HCLOUD_SERVER_TYPE:-?})"
[[ -n "$STACK_PID" ]] && { kill -INT "$STACK_PID" 2>/dev/null || true; sleep 5; }
[[ -n "${DEV_PID:-}" ]] && { kill -INT "$DEV_PID" 2>/dev/null || true; sleep 5; }

# --- keep the evidence: the logs of this run go to the branch sdd/logs (one rolling commit, replaced every run), because they die with the machine
save_logs() {
  local tar blob tree c
  tar="$(mktemp --suffix=.tar.gz)"
  ( cd "$REPO" && { echo "$LOG"; find specs -name '.*.log' ! -name '.specify.log' -size -3000k; [[ -f .sdd-monitor/progress.log ]] && echo .sdd-monitor/progress.log; } | tar czf "$tar" -T - 2>/dev/null )
  if [[ -s "$tar" ]] && (( $(stat -c %s "$tar") < 20000000 )); then
    blob="$(cd "$REPO" && git hash-object -w "$tar")"
    tree="$(cd "$REPO" && printf '100644 blob %s\tlogs-of-the-last-run.tar.gz\n' "$blob" | git mktree)"
    c="$(cd "$REPO" && git commit-tree "$tree" -m "SDD run logs $(date -u +%FT%TZ) (exit ${code:-?})")"
    ( cd "$REPO" && git push -q -f origin "$c:refs/heads/sdd/logs" 2>/dev/null ) && say "logs pushed to sdd/logs" || say "could not push the logs"
  fi
  rm -f "$tar"
}
save_logs

# --- keep everything: commit leftovers, push
git add -A >/dev/null 2>&1
if ! git diff --cached --quiet; then
  git commit -q -m "wip(sdd): uncommitted work when the run ended (exit $code)" || true
fi
pushed=""
for i in 1 2 3; do git push -q origin "HEAD:refs/heads/$PUSH_BRANCH" && { pushed=1; break; }; sleep 5; done
[[ -n "$pushed" ]] || fail_and_wait "the final push to $PUSH_BRANCH failed; the work is on this machine at $REPO"
say "pushed $(git rev-parse --short HEAD) to $PUSH_BRANCH"

case "$code" in
  0|75|76|77|78)
    ntfy "SDD runner done" "Branch $PUSH_BRANCH is pushed ($(git rev-parse --short HEAD)); peak memory $(cat "$LOG/peak-mem-mb" 2>/dev/null || echo ?) MB; deleting the machine. Pull it and test locally: git fetch origin && git checkout $PUSH_BRANCH" 3 white_check_mark
    destroy_now ;;
  *) fail_and_wait "the loop failed with exit code $code (work is pushed to $PUSH_BRANCH)" ;;
esac
