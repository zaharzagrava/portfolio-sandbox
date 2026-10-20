#!/usr/bin/env bash
# The flow scripts of the final checkpoint: the runtime proofs that no task may ask for during the run (lesson L-019). The sweep and the QA agent are run by checkpoint.sh itself.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
source scripts/sdd/ckpt-progress.sh; ckpt_init "${CKPT_LABEL:-final}"
rc=0
for app in core projector worker; do
  echo "== boot-app $app"
  scripts/infra/boot-app.sh "$app" --wait 170 | head -6 || rc=1
  if [[ ${PIPESTATUS[0]} == 0 ]]; then ckpt_note ok "app $app boots on its own" >/dev/null; else rc=1; ckpt_note fail "app $app does NOT boot on its own" >/dev/null; fi
done
echo "== fresh-run --here"; scripts/qa/fresh-run.sh --here && ckpt_note ok "fresh-stack run: ok" >/dev/null || { rc=1; ckpt_note fail "fresh-stack run FAILED" >/dev/null; }
echo "== scripted buy flow"; scripts/sdd/checkpoints/buy-ui.sh && ckpt_note ok "scripted buy flow: ok" >/dev/null || { rc=1; ckpt_note fail "scripted buy flow FAILED" >/dev/null; }
if [[ -s specs/deferred-checks.md ]]; then echo "== deferred by the doctor during the run (each is covered by the proofs above or needs a look):"; cat specs/deferred-checks.md; fi
exit "$rc"
