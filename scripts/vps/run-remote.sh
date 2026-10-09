#!/usr/bin/env bash
# Start an SDD run on a fresh machine created from the runner snapshot, then forget about it: the machine builds, commits and
# pushes to PUSH_BRANCH, sends phone notifications, and deletes itself.
#
#   scripts/vps/run-remote.sh [options] [capability IDs ...]
#     --until ID      stop after this capability (e.g. --until S53 for a one-spec first run); ID or ID:P1
#     --order NAME    order file in scripts/sdd/orders (default by-flow)
#     --hours N       hard end of the run (default RUN_HOURS from the config)
#     --keep          never delete the machine (debugging; you must delete it yourself)
#     --force         start even if another runner machine exists
#     --dry-run       print what would be created, with secrets masked
#     --no-check      skip the local test of the Claude token (normally done first: a few tokens, saves a wasted machine)
#   Without IDs the loop works through the whole order up to --until or the next checkpoint.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
source "$ROOT/scripts/vps/lib.sh"

UNTIL=""; ORDER=by-flow; HOURS=""; KEEP=""; FORCE=""; IDS=()
while (( $# )); do
  case "$1" in
    --until) UNTIL="$2"; shift 2 ;;
    --order) ORDER="$2"; shift 2 ;;
    --hours) HOURS="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-check) NO_CHECK=1; shift ;;
    -h|--help) sed -n 2,14p "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) IDS+=("$1"); shift ;;
  esac
done

load_config
require_tools hcloud git base64 curl
require_vars HCLOUD_TOKEN HCLOUD_SSH_KEY HCLOUD_LOCATION HCLOUD_SERVER_TYPE CLAUDE_CODE_OAUTH_TOKEN REPO_SSH_URL BASE_BRANCH PUSH_BRANCH DEPLOY_KEY_FILE NTFY_TOPIC
[[ -f "$DEPLOY_KEY_FILE" ]] || die "deploy key not found: $DEPLOY_KEY_FILE"
[[ -f "$ROOT/scripts/sdd/orders/$ORDER.txt" ]] || die "no order file scripts/sdd/orders/$ORDER.txt"
[[ -z "${ANTHROPIC_API_KEY:-}" ]] || die "ANTHROPIC_API_KEY is set in your environment; unset it (the runner must use the subscription)"
HOURS="${HOURS:-${RUN_HOURS:-5}}"
snap="$(snapshot_id)"; [[ -n "$snap" ]] || die "no snapshot yet: run scripts/vps/build-snapshot.sh first"

say "preflight"
tok="$CLAUDE_CODE_OAUTH_TOKEN"
case "$tok" in
  sk-ant-*) ;;
  *) die "CLAUDE_CODE_OAUTH_TOKEN does not start with sk-ant-: it is ${#tok} characters long and looks wrong (cut off when copied? run 'claude setup-token' again in a terminal and copy the whole token)" ;;
esac
[[ "$tok" =~ ^[A-Za-z0-9_-]+$ ]] || die "CLAUDE_CODE_OAUTH_TOKEN contains characters a token never has (spaces, quotes or line breaks from copying?)"
if [[ -z "${NO_CHECK:-}" && -z "${DRY_RUN:-}" ]]; then
  say "testing the Claude token on this laptop (isolated config, a few tokens)"
  cfg="$(mktemp -d)"
  if ! out="$(CLAUDE_CONFIG_DIR="$cfg" CLAUDE_CODE_OAUTH_TOKEN="$tok" timeout 120 claude -p "reply with the single word ok" --tools "" --no-session-persistence 2>&1)"; then
    rm -rf "$cfg"; die "the Claude token was rejected: ${out:0:200}"
  fi
  rm -rf "$cfg"
fi
git -C "$ROOT" fetch -q origin "$BASE_BRANCH"
if ! git -C "$ROOT" merge-base --is-ancestor HEAD "origin/$BASE_BRANCH"; then
  die "your local commits are not on origin/$BASE_BRANCH yet; the machine can only see what is pushed: git push origin $BASE_BRANCH"
fi
if [[ -z "$FORCE" && -z "${DRY_RUN:-}" ]] && [[ -n "$(hcloud server list --selector sdd-runner=run -o noheader 2>/dev/null)" ]]; then
  die "a runner machine already exists (hcloud server list --selector sdd-runner=run); use --force or delete it"
fi

# --- user data: runs once at first boot, writes the secrets, then hands over to scripts/vps/vm-run.sh from the fresh checkout
ud="$(mktemp)"; trap 'rm -f "$ud"' EXIT
{
  echo '#!/bin/bash'
  echo 'set -euo pipefail'
  echo 'umask 077'
  echo 'mkdir -p /etc/sdd /root/.ssh /var/log/sdd'
  echo "cat > /etc/sdd/env <<'SDD_ENV'"
  for v in HCLOUD_TOKEN CLAUDE_CODE_OAUTH_TOKEN NTFY_TOPIC NTFY_SERVER HEARTBEAT_URL REPO_SSH_URL BASE_BRANCH PUSH_BRANCH \
           PASS_TIMEOUT_S FAILURE_KEEP_MIN GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL; do
    printf '%s=%q\n' "$v" "${!v:-}"
  done
  printf '%s=%q\n' SDD_ORDER "$ORDER" SDD_UNTIL "$UNTIL" SDD_ARGS "${IDS[*]:-}" SDD_HOURS "$HOURS" SDD_KEEP "$KEEP"
  echo 'SDD_ENV'
  echo "base64 -d > /root/.ssh/sdd_deploy <<'SDD_KEY'"
  base64 -w0 "$DEPLOY_KEY_FILE"; echo
  echo 'SDD_KEY'
  echo 'chmod 600 /root/.ssh/sdd_deploy'
  echo 'echo "SERVER_ID=$(curl -fsS http://169.254.169.254/hetzner/v1/metadata/instance-id)" >> /etc/sdd/env'
  echo 'echo "SERVER_IP=$(curl -fsS http://169.254.169.254/hetzner/v1/metadata/public-ipv4)" >> /etc/sdd/env'
  echo 'cd /opt/sdd/repo'
  echo 'git fetch -q origin'
  echo 'git checkout -q -B sdd-boot "origin/$(. /etc/sdd/env; echo $BASE_BRANCH)"'
  echo 'systemd-run --unit=sdd-run --collect /opt/sdd/repo/scripts/vps/vm-run.sh'
} > "$ud"

name="sdd-run-$(date +%Y%m%d-%H%M%S)"
fw=(); [[ -n "${HCLOUD_FIREWALL:-}" ]] && fw=(--firewall "$HCLOUD_FIREWALL")
say "creating $name from snapshot $snap ($HCLOUD_SERVER_TYPE, $HCLOUD_LOCATION), order=$ORDER until=${UNTIL:-checkpoint/end} hours=$HOURS ids=${IDS[*]:-all}"
if [[ -n "${DRY_RUN:-}" ]]; then
  echo "--- user data (secrets masked) ---"
  sed -E 's/^((HCLOUD_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|NTFY_TOPIC|HEARTBEAT_URL)=).*/\1***masked***/' "$ud" | awk '/^base64 -d/ {print; getline; print "***deploy key masked***"; next} {print}' | sed -n 1,60p
  echo "--- command ---"
  run hcloud server create --name "$name" --type "$HCLOUD_SERVER_TYPE" --image "$snap" --location "$HCLOUD_LOCATION" --ssh-key "$HCLOUD_SSH_KEY" \
    --label sdd-runner=run --user-data-from-file "$ud" "${fw[@]}"
  exit 0
fi
hcloud server create --name "$name" --type "$HCLOUD_SERVER_TYPE" --image "$snap" --location "$HCLOUD_LOCATION" --ssh-key "$HCLOUD_SSH_KEY" \
  --label sdd-runner=run --user-data-from-file "$ud" "${fw[@]}"
ip="$(hcloud server ip "$name")"

curl -fsS -m 10 -H "Title: SDD runner created" -H "Tags: rocket" -d "$name is booting ($ip). Run: ${UNTIL:-until the next checkpoint}, up to ${HOURS}h. You get a message at every milestone." \
  "${NTFY_SERVER:-https://ntfy.sh}/$NTFY_TOPIC" >/dev/null 2>&1 || echo "WARN: could not reach ntfy; check NTFY_TOPIC / NTFY_SERVER"
cat <<MSG

Runner $name is booting at $ip. You can close the laptop now.
  watch it:     scripts/vps/attach.sh            (tmux with the stack, loop and monitor logs; Ctrl-b d to leave)
  when it ends: git fetch origin && git checkout $PUSH_BRANCH     (the machine deletes itself)
  safety nets:  hard stop after $((HOURS + 1))h, and scripts/vps/cleanup.sh removes stragglers
MSG
