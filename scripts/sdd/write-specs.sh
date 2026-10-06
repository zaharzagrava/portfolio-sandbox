#!/usr/bin/env bash
# Bulk spec writing (docs/architecture/sdd-runbook.md, step 2): runs `/speckit-specify` headless, one capability at
# a time, in catalog order. Built to run unattended for hours:
#   - a capability is done only when spec.md, test-plan.md, gaps.md and questions.md all exist; the script then
#     writes a `.spec-done` marker. Anything without the marker (interrupted, partial) is cleared and redone.
#   - a failed attempt is retried after each wait in RETRY_WAITS (seconds; default 10, 30, 60, 120 minutes, which
#     also rides out usage-limit windows); after the last one it is recorded and the run moves on.
#   - the run ends with a summary; exit status 1 if anything is still missing. Re-running resumes.
#
#   scripts/sdd/write-specs.sh                 # every capability: backend (S), web (W), journeys (J)
#   scripts/sdd/write-specs.sh S10 S13 W03     # only these IDs
#   scripts/sdd/write-specs.sh payments web    # every capability of these domain columns (`web`, `journeys` too)
#   DRY_RUN=1 scripts/sdd/write-specs.sh S10   # print the prompt, run nothing
#   RETRY_WAITS="60 300" scripts/sdd/write-specs.sh   # shorter retry waits
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
source "$ROOT/scripts/sdd/lib.sh"
cd "$ROOT"
read -r -a WAITS <<<"${RETRY_WAITS:-600 1800 3600 7200}"
REQUIRED=(spec.md test-plan.md gaps.md questions.md)

complete() { local f; for f in "${REQUIRED[@]}"; do [[ -s "$1/$f" ]] || return 1; done; }
stamp() { date '+%F %T'; }

failed=()
while IFS=$'\t' read -r id domain slug title sources; do
  dir="$(spec_dir "$domain" "$id" "$slug")"
  if [[ -f "$dir/.spec-done" ]]; then echo "skip  $id (done)"; continue; fi
  prompt="$(render_prompt "$(template_for "$domain")" "$id" "$domain" "$slug" "$title" "$sources" "$dir")"
  if [[ -n "${DRY_RUN:-}" ]]; then printf '===== %s\n/speckit-specify %s\n\n' "$id" "$prompt"; continue; fi

  ok=0
  for attempt in $(seq 0 "${#WAITS[@]}"); do
    rm -rf "$dir" && mkdir -p "$dir"                      # never build on a partial attempt
    echo "$(stamp) write $id → $dir (attempt $((attempt + 1)))"
    if SPECIFY_FEATURE_DIRECTORY="$dir" run_claude "$dir/.specify.log" "/speckit-specify $prompt" && complete "$dir"; then
      ok=1; break
    fi
    cp "$dir/.specify.log" "$dir/.specify.attempt-$((attempt + 1)).log" 2>/dev/null || true
    (( attempt < ${#WAITS[@]} )) || break
    echo "$(stamp) FAIL  $id (see $dir/.specify.log); retrying in $(( WAITS[attempt] / 60 )) min" >&2
    sleep "${WAITS[attempt]}"
  done

  if (( ok )); then
    date -u +%FT%TZ > "$dir/.spec-done"
    echo "$(stamp) done  $id"
  else
    echo "$(stamp) GIVE UP $id after $(( ${#WAITS[@]} + 1 )) attempts (logs in $dir); continuing" >&2
    failed+=("$id")
  fi
done < <(for_each_capability "$@")

if (( ${#failed[@]} )); then
  echo "Finished with ${#failed[@]} capability(ies) missing: ${failed[*]}. Re-run the same command to retry them." >&2
  exit 1
fi
echo "All requested specs are written. Next: scripts/sdd/review-questions.sh (optional), then implement-specs.sh."
