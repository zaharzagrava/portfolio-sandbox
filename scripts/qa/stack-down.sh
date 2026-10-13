#!/usr/bin/env bash
# Stops the API and removes the throwaway stack (and only its volumes) that stack-up.sh made.   scripts/qa/stack-down.sh <QA_DIR>
D="${1:?usage: stack-down.sh <QA_DIR>}"; ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"; cd "$ROOT"
for f in web.pid api.pid stack.pid; do [[ -f "$D/$f" ]] && { kill -- "-$(cat "$D/$f")" 2>/dev/null || kill "$(cat "$D/$f")" 2>/dev/null; }; done
pkill -f "nest start local-monolith" 2>/dev/null; pkill -f "next dev" 2>/dev/null; sleep 5
[[ -f "$D/project" ]] && COMPOSE_PROJECT_NAME="$(cat "$D/project")" docker compose -f docker-compose.yaml --env-file packages/backend/.env down -v >/dev/null 2>&1
echo "removed the throwaway stack $(cat "$D/project" 2>/dev/null)"
