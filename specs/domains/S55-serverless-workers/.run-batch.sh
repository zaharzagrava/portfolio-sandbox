#!/usr/bin/env bash
# Repro of one batch of the gate's backend e2e loop (same flags as implement-specs.sh gate()). Usage: .run-batch.sh <batch index>
dir=/opt/sdd/repo/specs/domains/S55-serverless-workers
n=${1:-0}
cd /opt/sdd/repo/packages/backend || exit 1
mapfile -t specs < <(NODE_ENV=test npx jest --config jest-e2e.json --listTests libs/infrastructure 2>/dev/null | grep -E 'e2e-spec\.ts$' | sort)
echo "specs=${#specs[@]} batch=$n"
NODE_ENV=test NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=6144" timeout 1800 \
  npx jest --ci --runInBand --forceExit --config jest-e2e.json --colors=false --runTestsByPath "${specs[@]:n*12:12}" > "$dir/.batch-$n.log" 2>&1
echo "batch $n exit=$?"
grep -E "^(Test Suites|Tests):|^FAIL|heap out of memory" "$dir/.batch-$n.log"
