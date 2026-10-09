#!/usr/bin/env bash
# Build the runner image once (and again whenever the stack or its dependencies change a lot): create a temporary machine,
# run bootstrap.sh on it, take a snapshot, delete the machine. Takes about 15-25 minutes and costs a few cents.
#
#   scripts/vps/build-snapshot.sh [--with-web]     (DRY_RUN=1 only prints what it would do)
#
# Prerequisite: the repo (including scripts/vps) is pushed to REPO_SSH_URL on BASE_BRANCH, because the machine clones it.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
source "$ROOT/scripts/vps/lib.sh"
WITH_WEB=""; [[ "${1:-}" == "--with-web" ]] && WITH_WEB=1

load_config
require_tools hcloud ssh scp git
require_vars HCLOUD_TOKEN HCLOUD_SSH_KEY HCLOUD_LOCATION HCLOUD_SERVER_TYPE REPO_SSH_URL BASE_BRANCH DEPLOY_KEY_FILE
[[ -f "$DEPLOY_KEY_FILE" ]] || die "deploy key not found: $DEPLOY_KEY_FILE"

git -C "$ROOT" fetch -q origin "$BASE_BRANCH" 2>/dev/null || true
if ! git -C "$ROOT" cat-file -e "origin/$BASE_BRANCH:scripts/vps/bootstrap.sh" 2>/dev/null; then
  die "origin/$BASE_BRANCH does not contain scripts/vps yet: push it first (git push origin $BASE_BRANCH)"
fi

mkdir -p "$SDD_VPS_STATE"
name="sdd-build-$(date +%Y%m%d-%H%M%S)"
desc="sdd-base-$(date +%Y%m%d-%H%M)"
say "creating $name ($HCLOUD_SERVER_TYPE in $HCLOUD_LOCATION)"
fw=(); [[ -n "${HCLOUD_FIREWALL:-}" ]] && fw=(--firewall "$HCLOUD_FIREWALL")
run hcloud server create --name "$name" --type "$HCLOUD_SERVER_TYPE" --image ubuntu-24.04 --location "$HCLOUD_LOCATION" \
  --ssh-key "$HCLOUD_SSH_KEY" --label sdd-runner=build "${fw[@]}"
if [[ -n "${DRY_RUN:-}" ]]; then
  say "DRY RUN: would copy bootstrap.sh and the deploy key, run it, power off, snapshot as '$desc', delete $name"; exit 0
fi

ip="$(hcloud server ip "$name")"
trap 'echo "build failed; deleting $name"; hcloud server delete "$name" >/dev/null 2>&1 || true' ERR
say "waiting for ssh on $ip"
wait_ssh "$ip" || die "ssh never came up on $ip"

say "bootstrapping (this is the long part)"
scp -q $SDD_SSH_OPTS "$ROOT/scripts/vps/bootstrap.sh" "root@$ip:/root/bootstrap.sh"
ssh $SDD_SSH_OPTS "root@$ip" 'mkdir -p /root/.ssh && chmod 700 /root/.ssh'
scp -q $SDD_SSH_OPTS "$DEPLOY_KEY_FILE" "root@$ip:/root/.ssh/sdd_deploy"
ssh $SDD_SSH_OPTS "root@$ip" "chmod 600 /root/.ssh/sdd_deploy && REPO_SSH_URL='$REPO_SSH_URL' BASE_BRANCH='$BASE_BRANCH' WITH_WEB='$WITH_WEB' bash /root/bootstrap.sh"

say "powering off and taking the snapshot '$desc'"
hcloud server shutdown "$name" >/dev/null
for _ in $(seq 1 30); do [[ "$(hcloud server describe "$name" -o format='{{.Status}}')" == off ]] && break; sleep 5; done
hcloud server create-image --type snapshot --description "$desc" --label sdd-runner=image "$name" | tee "$SDD_VPS_STATE/last-snapshot.txt"
id="$(hcloud image list --type snapshot --selector sdd-runner=image -o noheader -o columns=id,created | sort -k2 | tail -1 | awk '{print $1}')"
mkdir -p "$SDD_VPS_STATE"; echo "$id" > "$SDD_VPS_STATE/snapshot-id"
trap - ERR
hcloud server delete "$name" >/dev/null
say "done: snapshot $id ($desc). run-remote.sh will use it."
