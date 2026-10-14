#!/usr/bin/env bash
# The flow scripts of the final checkpoint: the runtime proofs that no task may ask for during the run (lesson L-019). The sweep and the QA agent are run by checkpoint.sh itself.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
rc=0
for app in core projector worker; do
  echo "== boot-app $app"
  scripts/infra/boot-app.sh "$app" --wait 170 | head -6 || rc=1
  [[ ${PIPESTATUS[0]} == 0 ]] || rc=1
done
echo "== fresh-run --here"; scripts/qa/fresh-run.sh --here || rc=1
echo "== scripted buy flow"; scripts/sdd/checkpoints/buy-ui.sh || rc=1
if [[ -s specs/deferred-checks.md ]]; then echo "== deferred by the doctor during the run (each is covered by the proofs above or needs a look):"; cat specs/deferred-checks.md; fi
exit "$rc"
