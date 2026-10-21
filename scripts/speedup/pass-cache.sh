#!/usr/bin/env bash
# pass-cache.sh: remembers which e2e spec files passed, so a file that passed with the SAME content is not run again.
#
# In plain words: for a spec file we compute one fingerprint (a hash) of the file itself, of every file it imports (directly or through
# other files, found by scripts/speedup/depgraph.py) and of the shared test setup (packages/backend/test, the Vitest config,
# package.json, migrations ...). If the fingerprint is the same as when the file last passed, running it again cannot give a new answer
# (the code it runs is the same), so it is skipped. Change one imported file, the setup, or the file itself and it runs again.
#
#   pass-cache.sh record <spec...>          store the current fingerprint of these files (call it for files that just PASSED)
#   pass-cache.sh record-report <json>      read a Vitest JSON report (--reporter=json) and record only the files that passed
#   pass-cache.sh check [spec...]           print the files that still NEED a run (never passed, or changed since). No file given = all specs.
#                                           A summary of what was skipped goes to stderr. Exit code is always 0.
#   pass-cache.sh last-commit               the git commit that was HEAD when something was last recorded (empty if nothing was)
#   pass-cache.sh forget                    empty the cache
#
# Spec paths are relative to packages/backend (libs/domains/orders/x.e2e-spec.ts); absolute paths are accepted and converted.
# The cache is the file specs/.checkpoints/pass-cache.jsonl (not committed); PASS_CACHE=<file> uses another one. One JSON line per
# record: { file, hash, commit, at }. The newest line of a file wins.
# Caveats: a file that passes only by luck (flaky) stays cached until something it imports changes; an environment change that is
# not in the files (a different database image) is not seen; delete the cache (forget) after such a change.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="${SPEEDUP_REPO:-$(git -C "$HERE" rev-parse --show-toplevel)}"; export SPEEDUP_REPO="$ROOT"
cache="${PASS_CACHE:-$ROOT/specs/.checkpoints/pass-cache.jsonl}"; mkdir -p "$(dirname "$cache")"
dg() { python3 "$HERE/depgraph.py" "$@"; }
rel() { local f; for f in "$@"; do f="${f#"$ROOT"/}"; f="${f#packages/backend/}"; echo "$f"; done; }

cmd="${1:-}"; shift || true
case "$cmd" in
  record)
    (( $# )) || exit 0
    mapfile -t files < <(rel "$@")
    commit="$(git -C "$ROOT" rev-parse HEAD)"
    dg hash "${files[@]}" | python3 -c '
import json, sys, time
cache, commit = sys.argv[1:3]
with open(cache, "a") as out:
    for line in sys.stdin:
        f, h = line.rstrip("\n").split("\t")
        out.write(json.dumps({"file": f, "hash": h, "commit": commit, "at": int(time.time())}) + "\n")
' "$cache" "$commit"
    ;;
  record-report)
    mapfile -t passed < <(python3 - "$1" <<'P'
import json, os, sys
for t in json.load(open(sys.argv[1])).get("testResults", []):
    if t.get("status") == "passed" and t.get("assertionResults"):
        print(t["name"])
P
)
    (( ${#passed[@]} )) && bash "${BASH_SOURCE[0]}" record "${passed[@]}"
    ;;
  check)
    if (( $# )); then mapfile -t files < <(rel "$@"); else mapfile -t files < <(dg specs); fi
    dg hash "${files[@]}" | python3 -c '
import json, os, sys
cache = sys.argv[1]
known = {}
if os.path.exists(cache):
    for l in open(cache):
        if l.strip():
            r = json.loads(l); known[r["file"]] = r["hash"]
need = skipped = 0
for line in sys.stdin:
    f, h = line.rstrip("\n").split("\t")
    if known.get(f) == h: skipped += 1
    else: need += 1; print(f)
print(f"pass-cache: {need} to run, {skipped} skipped (passed before with the same content)", file=sys.stderr)
' "$cache"
    ;;
  last-commit)
    [[ -s "$cache" ]] && tail -1 "$cache" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["commit"])'
    exit 0
    ;;
  forget) : > "$cache" ;;
  *) sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \?//'; exit 2 ;;
esac
