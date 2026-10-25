#!/usr/bin/env bash
# Plant 5 known bugs into a THROWAWAY git worktree ../portfolio-sandbox-planted, so the AI QA flow can be measured on code
# that contains bugs we know about. The main checkout and ../portfolio-sandbox-qa are never touched.
#
#   plant.sh              create the worktree from master (branch planted-bugs-sandbox) if missing, apply the 5 patches
#   plant.sh --check      only test that the patches apply to the current master (nothing is written)
#   plant.sh --probe      plant, then run the probe unit test: it must PASS on clean code and FAIL (5 bugs) on planted code
#   plant.sh --reset      take the bugs out again (git checkout of the worktree only)
#   plant.sh --remove     delete the worktree and its branch
# Needs node_modules links for --probe (made automatically as symlinks to the main checkout).
set -euo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN="$(git -C "$KIT" rev-parse --show-toplevel)"
WT="$(dirname "$MAIN")/portfolio-sandbox-planted"
BRANCH=planted-bugs-sandbox
PATCHES=("$KIT"/patches/*.patch)
[[ "$WT" == "$MAIN" ]] && { echo "refusing: worktree path equals main checkout" >&2; exit 2; }

ensure_wt() {
  if [[ ! -d "$WT/.git" && ! -f "$WT/.git" ]]; then git -C "$MAIN" worktree add -B "$BRANCH" "$WT" master >/dev/null; echo "created worktree $WT from master"; fi
  git -C "$WT" rev-parse --abbrev-ref HEAD | grep -qx "$BRANCH" || { echo "$WT is not on $BRANCH; refusing" >&2; exit 2; }
}
link_modules() { for d in node_modules packages/backend/node_modules packages/contracts/node_modules; do [[ -e "$WT/$d" ]] || ln -s "$MAIN/$d" "$WT/$d"; done; }
reset_wt() { git -C "$WT" checkout -q -- . ; }
apply_all() { for p in "${PATCHES[@]}"; do git -C "$WT" apply "$p" && echo "planted: $(basename "$p")"; done; }

case "${1:-}" in
  --check)
    tmp="$(mktemp -d)"; git -C "$MAIN" worktree add --detach "$tmp/wt" master >/dev/null
    rc=0; for p in "${PATCHES[@]}"; do git -C "$tmp/wt" apply --check "$p" && echo "applies: $(basename "$p")" || { echo "DOES NOT APPLY: $(basename "$p")"; rc=1; }; done
    git -C "$MAIN" worktree remove --force "$tmp/wt"; rmdir "$tmp" 2>/dev/null || true; exit $rc ;;
  --reset) ensure_wt; reset_wt; echo "worktree is clean again" ;;
  --remove) git -C "$MAIN" worktree remove --force "$WT"; git -C "$MAIN" branch -D "$BRANCH"; echo removed ;;
  --probe)
    ensure_wt; link_modules; reset_wt
    PROBE="$WT/packages/backend/libs/domains/catalog/planted-probe.spec.ts"; cp "$KIT/probes/planted-probe.spec.ts" "$PROBE"
    runp() { (cd "$WT/packages/backend" && NODE_OPTIONS=--experimental-vm-modules NODE_ENV=test npx jest libs/domains/catalog/planted-probe.spec.ts --coverage=false 2>&1 | grep -E "✓|✕|Tests:"); }
    echo "--- clean code (all probes must pass)"; runp || true
    apply_all >/dev/null; echo "--- planted code (every bug probe must fail)"; runp || true
    rm -f "$PROBE"; reset_wt; echo "worktree reset" ;;
  "")
    ensure_wt; reset_wt; apply_all
    echo; echo "Planted worktree: $WT (branch $BRANCH). Point the AI QA flow at this tree. Do NOT read $KIT/reveal.md or $KIT/patches in tester prompts." ;;
  *) echo "usage: plant.sh [--check|--probe|--reset|--remove]" >&2; exit 2 ;;
esac
