#!/usr/bin/env bash
# run-sharded.sh [N]: the whole backend e2e suite split into N slices that run at the same time on the shared test stack (default 5).
#   Each slice has its own names for everything on the shared services (see scripts/infra/shard-prepare.sh), so slices do not touch each other.
#   Writes per-slice results to specs/.checkpoints/sharded/ (vitest json) and prints: the wall-clock time, tests passed/failed, the failing
#   files, and the 15 slowest files. Needs the test stack up (scripts/infra/stack.sh test setup).
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"; cd "$ROOT"
N="${1:-5}"; out="$ROOT/specs/.checkpoints/sharded"; rm -rf "$out"; mkdir -p "$out"
t0=$SECONDS
for n in $(seq 1 "$N"); do scripts/infra/shard-prepare.sh "$n" > "$out/prepare-$n.log" 2>&1 || { echo "prepare of shard $n failed, see $out/prepare-$n.log"; exit 1; }; done
echo "prepared $N shards in $((SECONDS - t0)) s"
t1=$SECONDS
for n in $(seq 1 "$N"); do
  scripts/infra/shard-run.sh "$n" "$N" --reporter=json --outputFile="$out/result-$n.json" > "$out/run-$n.log" 2>&1 &
done
wait
echo "ran $N shards in parallel: $((SECONDS - t1)) s (total with preparing: $((SECONDS - t0)) s)"
python3 - "$out" <<'P'
import glob, json, sys, os
out = sys.argv[1]; passed = failed = 0; files = []; bad = []
for p in sorted(glob.glob(out + '/result-*.json')):
    d = json.load(open(p)); passed += d.get('numPassedTests', 0); failed += d.get('numFailedTests', 0)
    for t in d.get('testResults', []):
        name = t['name'].split('packages/backend/')[-1]; dur = (t.get('endTime', 0) - t.get('startTime', 0)) / 1000
        files.append((dur, name, len(t.get('assertionResults', []))))
        f = [a['fullName'] for a in t.get('assertionResults', []) if a.get('status') == 'failed']
        if f or (not t.get('assertionResults') and t.get('status') == 'failed'): bad.append((name, f or ['suite failed to start']))
missing = [i for i in range(1, 100) if False]
print('tests passed %d, failed %d, files %d' % (passed, failed, len(files)))
print('failing files (%d):' % len(bad))
for n, f in bad: print('  ', n, '|', f[0][-80:], '(+%d)' % (len(f) - 1) if len(f) > 1 else '')
print('slowest 15 files (seconds):')
for dur, name, n in sorted(files, reverse=True)[:15]: print('  %6.1f  %3d tests  %s' % (dur, n, name))
for p in sorted(glob.glob(out + '/run-*.log')):
    if not os.path.exists(p.replace('run-', 'result-').replace('.log', '.json')): print('NO RESULT FILE for', os.path.basename(p), '- the slice crashed, tail of its log:'); print(''.join(open(p, errors='replace').readlines()[-6:]))
P
