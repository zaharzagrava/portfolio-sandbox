#!/usr/bin/env bash
# sweep-backend.sh [log]: the backend e2e sweep of the checkpoint, on its own (a local run, or a rerun of one phase).
#   Every e2e suite (libs, apps), SWEEP_BATCH per fresh jest process (default 12), one after the other, then the verdict of sweep-verdict.py.
#   Needs the TEST stack (scripts/infra/stack.sh test setup) and packages/backend/.env.test (cp -f packages/backend/env/test.env.example packages/backend/.env.test).
#   SWEEP_HEAP_MB (default 4096) is the heap of each jest process; ONLY=<regex> sweeps only the suites whose path matches.
# Exit 0 = the sweep passed (sweep-verdict.py prints FAILED: lines otherwise). The progress goes to stdout, the jest output to the log.
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"; cd "$ROOT"
log="${1:-$ROOT/specs/.checkpoints/backend-sweep.log}"; mkdir -p "$(dirname "$log")"; : > "$log"
mapfile -t all_specs < <(cd packages/backend && NODE_ENV=test npx jest --config jest-e2e.json --listTests 2>/dev/null | grep -E 'e2e-spec\.ts$' | sort)
[[ -n "${ONLY:-}" ]] && mapfile -t all_specs < <(printf '%s\n' "${all_specs[@]}" | grep -E "$ONLY")
total=${#all_specs[@]}; batch=${SWEEP_BATCH:-12}; heap=${SWEEP_HEAP_MB:-4096}
(( total )) || { echo "no e2e suites found"; exit 1; }
echo "sweep: $total suites in batches of $batch (log: $log)"
for (( i = 0; i < total; i += batch )); do
  echo "backend e2e sweep: suites $((i + 1))-$(( i + batch < total ? i + batch : total )) of $total" >>"$log"
  t0=$SECONDS
  (cd packages/backend && NODE_ENV=test NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=$heap" timeout "${SWEEP_TIMEOUT_S:-3600}" \
     npx jest --ci --runInBand --forceExit --config jest-e2e.json --colors=false --runTestsByPath "${all_specs[@]:i:batch}") >>"$log" 2>&1
  echo "  batch $((i / batch + 1)) of $(( (total + batch - 1) / batch )): $(grep -a '^Test Suites:' "$log" | tail -1) ($((SECONDS - t0)) s)"
done
summaries=$(grep -ac '^Test Suites:' "$log"); batches=$(( (total + batch - 1) / batch ))
(( summaries == batches )) || { echo "a batch ended without a summary ($summaries of $batches): the process crashed"; exit 1; }
python3 "$ROOT/scripts/sdd/sweep-verdict.py" "$log" | tee -a "$log"
python3 "$ROOT/scripts/sdd/sweep-verdict.py" "$log" | grep -q '^FAILED:' && exit 1
exit 0
