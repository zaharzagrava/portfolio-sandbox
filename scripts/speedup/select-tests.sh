#!/usr/bin/env bash
# select-tests.sh [base-ref] [--unpassed]: prints the e2e spec files that need a rerun because of what changed. One path per line,
# relative to packages/backend, so the output can be handed to scripts/sdd/vitest-batch.sh or `vitest run`.
#
# In plain words:
#   1. "What changed": every file that differs from base-ref (committed after it, edited, or new and not yet committed).
#      base-ref defaults to the last commit the pass-cache remembers (pass-cache.sh last-commit), else HEAD~1.
#   2. If a changed file is shared test infrastructure (packages/backend/test/**, the Vitest config, package.json, migrations,
#      the lockfile ... the GLOBAL list in depgraph.py), every spec is printed ("run everything"). FULL=1 forces this too.
#   3. Otherwise a spec is printed when it, or any file it imports (directly or through other files), changed. This is the module
#      graph that `vitest related` would use; we crawl the imports ourselves (depgraph.py) because `vitest related` runs the tests
#      instead of only listing them. Changes outside packages/backend and packages/contracts (docs, web, scripts, specs) select nothing.
#   4. --unpassed: also drop the specs that passed before with the same content (pass-cache.sh), leaving only what needs a run.
# Notes (a summary) go to stderr, so stdout stays a clean list.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="${SPEEDUP_REPO:-$(git -C "$HERE" rev-parse --show-toplevel)}"; export SPEEDUP_REPO="$ROOT"; cd "$ROOT"
base=""; unpassed=0
for a in "$@"; do case "$a" in --unpassed) unpassed=1;; *) base="$a";; esac; done
if [[ -z "$base" ]]; then
  base="$(bash "$HERE/pass-cache.sh" last-commit 2>/dev/null)"
  git rev-parse --verify -q "${base:-none}^{commit}" >/dev/null || base="HEAD~1"
fi
git rev-parse --verify -q "$base^{commit}" >/dev/null || { echo "select-tests: unknown ref $base" >&2; exit 2; }
mapfile -t changed < <({ git diff --name-only "$base" --; git ls-files -o --exclude-standard; } | sort -u)
if [[ "${FULL:-0}" == 1 ]]; then mapfile -t specs < <(python3 "$HERE/depgraph.py" specs); why="FULL=1"
else
  mapfile -t specs < <(python3 "$HERE/depgraph.py" select "${changed[@]}")
  why="${#changed[@]} changed file(s) since $(git rev-parse --short "$base")"
fi
if (( unpassed && ${#specs[@]} )); then
  mapfile -t specs < <(bash "$HERE/pass-cache.sh" check "${specs[@]}" 2>/dev/null)
fi
echo "select-tests: ${#specs[@]} spec(s) to run ($why)" >&2
(( ${#specs[@]} )) && printf '%s\n' "${specs[@]}"
exit 0
