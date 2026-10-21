#!/usr/bin/env bash
# shard-run.sh <n> <total> [vitest args]: runs slice n of <total> of the backend e2e suites on the shared test stack, with shard n's names.
#   scripts/infra/shard-prepare.sh <n> must have run once. Extra arguments go to vitest (a file filter, --reporter ...).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
n="${1:?shard number (1..15)}"; total="${2:?number of shards}"; shift 2
(( n >= 1 && n <= total )) || { echo "shard $n is outside 1..$total" >&2; exit 2; }
set -a; eval "$("$ROOT/scripts/infra/shard-env.sh" "$n")"; set +a
cd "$ROOT/packages/backend"
export NODE_ENV=test UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-8}"
exec npx vitest run --config vitest.e2e.config.ts --shard="$n/$total" "$@"
