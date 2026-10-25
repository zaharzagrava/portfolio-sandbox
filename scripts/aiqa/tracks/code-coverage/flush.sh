#!/usr/bin/env bash
# Stops the web server and the API of a stack that was started with QA_COVERAGE=1, the polite way (Ctrl-C), so that Node writes its coverage files.
#   scripts/aiqa/tracks/code-coverage/flush.sh <QA_DIR>      then:  scripts/qa/stack-down.sh <QA_DIR>  (removes the rest)
# stack-down.sh alone kills them with SIGTERM, and a process killed that way writes no coverage.
set -uo pipefail
D="${1:?usage: flush.sh <QA_DIR>}"
for f in web.pid api.pid lambda.pid; do [[ -f "$D/$f" ]] && { kill -INT -- "-$(cat "$D/$f")" 2>/dev/null || kill -INT "$(cat "$D/$f")" 2>/dev/null; }; done
for _ in $(seq 1 30); do pgrep -f "next dev|nest start local-monolith" >/dev/null || break; sleep 1; done
for d in v8-web v8-api; do echo "$d: $(ls "$D/$d" 2>/dev/null | wc -l) coverage file(s) in $D/$d"; done
