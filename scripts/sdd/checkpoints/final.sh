#!/usr/bin/env bash
# The flow scripts of the final checkpoint: every scripted walk of a flow that exists, one after the other. The sweep and the QA agent are run by checkpoint.sh itself.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
rc=0
for f in buy-ui.sh; do
  echo "== flow script $f"
  ./"$f" || rc=1
done
exit "$rc"
