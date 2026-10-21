#!/usr/bin/env bash
# check-ready.sh: checks the test files that the helper agents have finished editing, one file at a time, against the test stack.
#   A helper appends a finished file's path (relative to packages/backend) to specs/.checkpoints/speedup-ready.txt.
#   This script takes the paths not checked yet, runs each one alone with Vitest, and writes one line per file to
#   specs/.checkpoints/speedup-results.jsonl: { file, passed, failed, seconds, failedTests: [...] }.
#   Files that fail go to specs/.checkpoints/speedup-failed.txt for a fix round. Run with WATCH=1 to keep waiting for new files.
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"; cd "$ROOT"
dir="$ROOT/specs/.checkpoints"; mkdir -p "$dir"; ready="$dir/speedup-ready.txt"; results="$dir/speedup-results.jsonl"; failed="$dir/speedup-failed.txt"; touch "$ready" "$results" "$failed"
check_one() {
  local f="$1" t0=$SECONDS out json
  json="$(mktemp)"
  (cd packages/backend && NODE_ENV=test timeout "${CHECK_TIMEOUT_S:-600}" npx vitest run --config vitest.e2e.config.ts --reporter=json --outputFile="$json" "$f" >/dev/null 2>&1)
  python3 - "$f" "$json" "$((SECONDS - t0))" "$results" "$failed" <<'P'
import json, sys
f, jp, secs, results, failed = sys.argv[1:6]
try:
    d = json.load(open(jp))
    names = [a['fullName'] for t in d.get('testResults', []) for a in t.get('assertionResults', []) if a.get('status') == 'failed']
    line = {'file': f, 'passed': d.get('numPassedTests', 0), 'failed': d.get('numFailedTests', 0), 'seconds': int(secs), 'failedTests': names[:10]}
    if d.get('numTotalTests', 0) == 0 or any(t.get('status') == 'failed' and not t.get('assertionResults') for t in d.get('testResults', [])):
        line['failed'] = max(line['failed'], 1); line['failedTests'] = names[:10] or ['suite failed to start']
except Exception as e:
    line = {'file': f, 'passed': 0, 'failed': 1, 'seconds': int(secs), 'failedTests': ['no result file: %s' % e]}
open(results, 'a').write(json.dumps(line) + '\n')
if line['failed']: open(failed, 'a').write(f + '\n')
print(('FAIL ' if line['failed'] else 'ok   ') + f, '%ss' % secs, '%d passed, %d failed' % (line['passed'], line['failed']))
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
  for f in "${todo[@]}"; do check_one "$f"; done
  [[ "${WATCH:-0}" == 1 ]] || break
  (( ${#todo[@]} )) || sleep 5
done
