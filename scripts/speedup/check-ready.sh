#!/usr/bin/env bash
# check-ready.sh: checks the test files that the helper agents have finished editing, one file at a time, against the test stack.
#   A helper appends a finished file's path (relative to packages/backend) to specs/.checkpoints/speedup-ready.txt.
#   This script takes the paths not checked yet, runs each one alone with Vitest, and writes one line per file to
#   specs/.checkpoints/speedup-results.jsonl: { file, passed, failed, seconds, failedTests: [...] }.
#   Files that fail go to specs/.checkpoints/speedup-failed.txt for a fix round. Run with WATCH=1 to keep waiting for new files.
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"; cd "$ROOT"
dir="$ROOT/specs/.checkpoints"; mkdir -p "$dir"; ready="$dir/speedup-ready.txt"; results="$dir/speedup-results.jsonl"; failed="$dir/speedup-failed.txt"; touch "$ready" "$results" "$failed"
check_batch() {  # one Vitest process for several files: the 15 to 20 s of code loading is paid once, not once per file
  local json t0=$SECONDS; json="$(mktemp)"
  (cd packages/backend && NODE_ENV=test timeout "${CHECK_TIMEOUT_S:-1800}" npx vitest run --config vitest.e2e.config.ts --reporter=json --outputFile="$json" "$@" >/dev/null 2>&1)
  python3 - "$json" "$((SECONDS - t0))" "$results" "$failed" "$@" <<'P'
import json, sys
jp, secs, results, failed = sys.argv[1:5]; files = sys.argv[5:]
seen = {}
try:
    d = json.load(open(jp))
    for t in d.get('testResults', []):
        name = t['name']; rel = name[name.index('packages/backend/') + len('packages/backend/'):] if 'packages/backend/' in name else name
        a = t.get('assertionResults', [])
        bad = [x['fullName'] for x in a if x.get('status') == 'failed']
        if not a and t.get('status') == 'failed': bad = ['suite failed to start: ' + str(t.get('message', ''))[:120]]
        seen[rel] = (sum(1 for x in a if x.get('status') == 'passed'), bad)
except Exception as e:
    pass
for f in files:
    passed, bad = seen.get(f, (0, ['no result (the batch crashed or the file was not found)']))
    line = {'file': f, 'passed': passed, 'failed': len(bad), 'seconds': int(secs), 'failedTests': bad[:10]}
    open(results, 'a').write(json.dumps(line) + '\n')
    if bad: open(failed, 'a').write(f + '\n')
    print(('FAIL ' if bad else 'ok   ') + f, '%d passed, %d failed' % (passed, len(bad)))
print('batch of %d files: %s s' % (len(files), secs))
P
  rm -f "$json"
}
while :; do
  mapfile -t todo < <(python3 - "$ready" "$results" <<'P'
import json, sys
done = {json.loads(l)['file'] for l in open(sys.argv[2]) if l.strip()}
seen = set()
for l in open(sys.argv[1]):
    l = l.strip()
    if l and l not in done and l not in seen:
        seen.add(l); print(l)
P
)
  for (( i = 0; i < ${#todo[@]}; i += ${CHECK_BATCH:-15} )); do check_batch "${todo[@]:i:${CHECK_BATCH:-15}}"; done
  [[ "${WATCH:-0}" == 1 ]] || break
  (( ${#todo[@]} )) || sleep 5
done
