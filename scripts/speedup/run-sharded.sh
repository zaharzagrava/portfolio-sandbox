#!/usr/bin/env bash
# run-sharded.sh [N]: the whole backend e2e suite split into N slices that run at the same time on the shared test stack (default 5).
#   Each slice has its own names for everything on the shared services (see scripts/infra/shard-prepare.sh), so slices do not touch each other.
#   Writes per-slice results to specs/.checkpoints/sharded/ (vitest json) and prints: the wall-clock time, tests passed/failed, the failing
#   files, and the 15 slowest files. Needs the test stack up (scripts/infra/stack.sh test setup).
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"; cd "$ROOT"
N="${1:-5}"; out="$ROOT/specs/.checkpoints/sharded"; rm -rf "$out"; mkdir -p "$out"
t0=$SECONDS
[[ "${RESET:-1}" == 0 ]] || for n in $(seq 1 "$N"); do scripts/infra/shard-reset.sh "$n" > "$out/reset-$n.log" 2>&1 & done; wait   # clean slate for each slice (RESET=0 skips)
for n in $(seq 1 "$N"); do scripts/infra/shard-prepare.sh "$n" > "$out/prepare-$n.log" 2>&1 || { echo "prepare of shard $n failed, see $out/prepare-$n.log"; exit 1; }; done
echo "prepared $N shards in $((SECONDS - t0)) s"
t1=$SECONDS
# Split by measured TIME (scripts/speedup/balance.py, from the previous run's per-file durations in specs/.checkpoints/durations.json), not by file count.
# Without durations (first run) vitest's own --shard=i/N is used. BALANCE=0 forces that.
dur="$ROOT/specs/.checkpoints/durations.json"; balanced=0
if [[ "${BALANCE:-1}" != 0 && -f "$dur" ]]; then
  (cd packages/backend && npx vitest list --filesOnly --config vitest.e2e.config.ts 2>/dev/null | sed 's#.*packages/backend/##' | grep 'e2e-spec' | sort) > "$out/all-specs.txt"
  python3 scripts/speedup/balance.py "$N" "$dur" "$out/all-specs.txt" "$out" && balanced=1
fi
pids=()
for n in $(seq 1 "$N"); do
  if (( balanced )); then slice=(0 $(cat "$out/list-$n.txt")); else slice=("$N"); fi
  FAIL_LOG="$out/fails-$n.txt" setsid scripts/infra/shard-run.sh "$n" "${slice[@]}" --reporter=default --reporter=json --reporter=./test/fail-log-reporter.ts --outputFile.json="$out/result-$n.json" > "$out/run-$n.log" 2>&1 &
  pids+=($!)
done
# Live progress, and stop early: every 15 s print how many files are done / failing; when more than ABORT_AFTER files fail, kill every slice
# (default 1: stop at the FIRST failing file; ABORT_AFTER=0 never aborts) and show the first errors, so the fixing can start at once instead of after the whole run.
abort="${ABORT_AFTER:-1}"; aborted=0
while :; do
  alive=0; for p in "${pids[@]}"; do kill -0 "$p" 2>/dev/null && alive=1; done
  (( alive )) || break
  sleep 5
  clean() { sed 's/\x1b\[[0-9;]*m//g' "$out"/run-*.log; }
  done_files=$(clean | grep -aEc '^ (✓|❯|×) [a-z].*e2e-spec\.ts')
  failing=$(clean | grep -aE '^ (❯|×) [a-z].*e2e-spec\.ts.*failed' | sort -u | wc -l)
  echo "[$((SECONDS - t1)) s] $done_files of ~593 files done, $failing failing"
  if (( abort > 0 && failing >= abort )); then
    aborted=1; echo "STOP: $failing files failing (limit $abort) - killing all slices to start fixing"
    for p in "${pids[@]}"; do kill -INT -- "-$p" 2>/dev/null; done   # setsid made each slice its own process group; Vitest prints its failure details on SIGINT
    sleep 3; for p in "${pids[@]}"; do kill -KILL -- "-$p" 2>/dev/null; done
    echo "--- first failing files:"
    clean | grep -aE '^ (❯|×) [a-z].*e2e-spec\.ts.*failed' | sort -u | head -20
    echo "--- the failures (file | test | first error line):"
    cat "$out"/fails-*.txt 2>/dev/null | head -60
    break
  fi
done
wait 2>/dev/null
(( aborted )) && { echo "run stopped early; logs in $out/run-*.log"; exit 3; }
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
json.dump({n: round(d, 1) for d, n, _ in files}, open(os.path.join(os.path.dirname(out), 'durations.json'), 'w'))
print('tests passed %d, failed %d, files %d' % (passed, failed, len(files)))
print('failing files (%d):' % len(bad))
for n, f in bad: print('  ', n, '|', f[0][-80:], '(+%d)' % (len(f) - 1) if len(f) > 1 else '')
print('slowest 15 files (seconds):')
for dur, name, n in sorted(files, reverse=True)[:15]: print('  %6.1f  %3d tests  %s' % (dur, n, name))
for p in sorted(glob.glob(out + '/run-*.log')):
    if not os.path.exists(p.replace('run-', 'result-').replace('.log', '.json')): print('NO RESULT FILE for', os.path.basename(p), '- the slice crashed, tail of its log:'); print(''.join(open(p, errors='replace').readlines()[-6:]))
P
