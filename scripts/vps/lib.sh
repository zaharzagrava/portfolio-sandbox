# Helpers for the laptop-side scripts in scripts/vps (sourced).
SDD_VPS_CONFIG="${SDD_VPS_CONFIG:-$HOME/.config/sdd-vps/config.env}"
SDD_VPS_STATE="${SDD_VPS_STATE:-$HOME/.config/sdd-vps}"

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo "==> $*"; }

# run a command, or only print it with DRY_RUN=1
run() { if [[ -n "${DRY_RUN:-}" ]]; then printf 'DRY  '; printf '%q ' "$@"; echo; else "$@"; fi; }

load_config() {
  [[ -f "$SDD_VPS_CONFIG" ]] || die "no config at $SDD_VPS_CONFIG (copy scripts/vps/config.example.env there and fill it in)"
  local mode; mode="$(stat -c %a "$SDD_VPS_CONFIG")"
  [[ "$mode" == 600 || "$mode" == 400 ]] || die "$SDD_VPS_CONFIG must be chmod 600 (it holds tokens), it is $mode"
  set -a; source "$SDD_VPS_CONFIG"; set +a
  DEPLOY_KEY_FILE="${DEPLOY_KEY_FILE/#\~/$HOME}"
  export HCLOUD_TOKEN
}

require_vars() { local v; for v in "$@"; do [[ -n "${!v:-}" ]] || die "$v is empty in $SDD_VPS_CONFIG"; done; }

require_tools() { local t; for t in "$@"; do command -v "$t" >/dev/null || die "missing tool: $t"; done; }

# wait until ssh answers on $1
wait_ssh() {
  local ip="$1" i
  for i in $(seq 1 60); do
    ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "root@$ip" true 2>/dev/null && return 0
    sleep 5
  done
  return 1
}

snapshot_id() { cat "$SDD_VPS_STATE/snapshot-id" 2>/dev/null || true; }
