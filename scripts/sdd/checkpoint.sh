#!/usr/bin/env bash
# checkpoint.sh <label>: what must be true before the loop pauses at a "!STOP <label>" checkpoint.
#   1. Regression sweep: every backend e2e spec built so far still passes. The per-capability gate only runs the e2e specs
#      of the capability being built, so a later spec that edits shared code could break an earlier one unseen.
#   2. If the dev stack is up (GET $API_URL/health/ready) and packages/web has Playwright specs: the web suite still passes.
#   3. scripts/sdd/checkpoints/<label>.sh, if it exists: a scripted walk of the flow (exit 0 = the flow works).
# Exit 0 = the checkpoint may be passed. CHECKPOINT_SWEEP=0 skips 1 and 2 (the label script still runs).
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"
label="${1:?usage: checkpoint.sh <label>}"
API_URL="${API_URL:-http://localhost:8000}"
log="$ROOT/specs/.checkpoints/$label.log"
mkdir -p "$ROOT/specs/.checkpoints"; : > "$log"
fail=0

# the monolith must boot before anything else is worth running (the unit and e2e suites build their own small modules)
if [[ -n "${API_LOG:-}${BOOT_CHECK:-}" ]]; then
  echo "  checkpoint $label: boot check"
  scripts/infra/boot-check.sh --wait "${BOOT_WAIT:-240}" >>"$log" 2>&1 || { echo "  boot check FAILED: the API does not start (the Nest errors are in $log)"; fail=1; }
fi

if [[ "${CHECKPOINT_SWEEP:-1}" != 0 ]]; then
  echo "  checkpoint $label: backend e2e sweep (log: $log)"
  # One jest process for all ~70 suites ran out of memory (4 GB heap) after ~16 minutes: the late suites then ran in a process whose
  # garbage collector paused for seconds, which looked like 503s, dropped connections and bad timers. The suites run one at a time,
  # in batches of SWEEP_BATCH, each batch in a fresh process.
  backend_sweep_failed=0
  mapfile -t all_specs < <(cd packages/backend && NODE_ENV=test npx jest --config jest-e2e.json --listTests 2>/dev/null | grep -E 'e2e-spec\.ts$' | sort)
  total=${#all_specs[@]}; batch=${SWEEP_BATCH:-12}
  for (( i = 0; i < total; i += batch )); do
    echo "  backend e2e sweep: suites $((i + 1))-$(( i + batch < total ? i + batch : total )) of $total" >>"$log"
    (cd packages/backend && NODE_ENV=test NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=6144" timeout "${SWEEP_TIMEOUT_S:-3600}" \
       npx jest --ci --runInBand --forceExit --config jest-e2e.json --colors=false --runTestsByPath "${all_specs[@]:i:batch}") >>"$log" 2>&1 || backend_sweep_failed=1
  done
  # Old e2e tests of features that are still to be rebuilt (a domain with no built capability) are expected to be red and do not count; a
  # batch that ended without its summary line crashed, which always counts.
  summaries=$(grep -c '^Test Suites:' "$log"); batches=$(( (total + batch - 1) / batch ))
  if (( total == 0 )); then
    backend_sweep_failed=1; echo "no backend e2e specs found" >>"$log"
  elif (( summaries != batches )); then
    backend_sweep_failed=1; echo "a sweep batch ended without a summary ($summaries of $batches): the process crashed" | tee -a "$log"
  elif python3 "$ROOT/scripts/sdd/sweep-verdict.py" "$log" | tee -a "$log" | grep -q '^FAILED:'; then
    backend_sweep_failed=1
  else
    backend_sweep_failed=0
  fi
  if (( backend_sweep_failed )); then echo "  backend e2e sweep FAILED"; fail=1; fi
  if [[ -d packages/web ]] && ls packages/web/playwright.config.* >/dev/null 2>&1 && curl -sf "$API_URL/health/ready" >/dev/null; then
    echo "  checkpoint $label: web (Playwright) sweep"
    (cd packages/web && timeout "${SWEEP_TIMEOUT_S:-3600}" npx playwright test --reporter=list ${PW_WORKERS:+--workers="$PW_WORKERS"}) >>"$log" 2>&1 || { echo "  web sweep FAILED"; fail=1; }
  fi
fi

# The living specification must agree with the code and the tests (docs/spec); the models run only where Node is available.
if [[ -d docs/spec && -f scripts/livespec/check.py ]]; then
  echo "  checkpoint $label: living specification" >>"$log"
  base_arg=(); git rev-parse -q --verify "${CHECKPOINT_BASE:-origin/master}" >/dev/null && base_arg=(--base "${CHECKPOINT_BASE:-origin/master}")
  { python3 scripts/livespec/check.py "${base_arg[@]}" && python3 scripts/livespec/models.py check && python3 scripts/livespec/test_livespec.py 2>&1 | tail -3 \
      && { ! command -v npx >/dev/null || python3 scripts/livespec/run_models.py; }; } >>"$log" 2>&1 || { echo "  living specification check FAILED"; fail=1; }
fi

script="$ROOT/scripts/sdd/checkpoints/$label.sh"
if [[ -x "$script" ]]; then
  echo "  checkpoint $label: flow script"
  "$script" >>"$log" 2>&1 || { echo "  flow script FAILED"; fail=1; }
fi

# Opt-in: the QA agent (a Claude session that uses the product like a person), e.g. CHECKPOINT_QA="buy account". Needs the web server on :3000 and the API.
qa_marker="$ROOT/specs/.checkpoints/$label.qa-done"   # the agent runs once per checkpoint; after a repair only the tests it left behind run again
if [[ -n "${CHECKPOINT_QA:-}" && -x "$ROOT/scripts/qa/pipeline.sh" && ! -f "$qa_marker" ]]; then
  qa_list="$CHECKPOINT_QA"
  if [[ "$CHECKPOINT_QA" == auto ]]; then   # selective: draft charters for built capabilities nobody covers, then only the charters whose capabilities changed, within QA_BUDGET_MIN
    "$ROOT/scripts/qa/make-charters.sh" >>"$log" 2>&1 || true
    qa_list="$("$ROOT/scripts/qa/select.py" --explain 2>>"$log")"
  fi
  [[ -n "$qa_list" ]] || { echo "  checkpoint $label: QA agent: nothing it covers changed"; : > "$qa_marker"; qa_list=""; }
  echo "  checkpoint $label: QA agent (${qa_list:-none})"
  web_pid=""
  if [[ -n "$qa_list" ]] && ! curl -sf localhost:3000 >/dev/null; then   # the sweeps start the web server themselves and stop it; the agent needs one that stays up
    (cd "$ROOT/packages/web" && NEXT_PUBLIC_PAYMENTS_SANDBOX=true setsid pnpm run dev >>"$log" 2>&1 & echo $! >"$ROOT/.qa-web.pid"); web_pid="$(cat "$ROOT/.qa-web.pid")"
    for _ in $(seq 1 60); do curl -sf localhost:3000 >/dev/null && break; sleep 3; done
  fi
  [[ -z "$qa_list" ]] || API_LOG="${API_LOG:-$ROOT/.sdd-api.log}" "$ROOT/scripts/qa/pipeline.sh" $qa_list >>"$log" 2>&1 || { echo "  QA pipeline left failing regression tests in packages/web/tests/qa (or could not run); see specs/.qa"; fail=1; }
  : > "$qa_marker"
  [[ -n "$web_pid" ]] && { kill -- "-$web_pid" 2>/dev/null || kill "$web_pid" 2>/dev/null; rm -f "$ROOT/.qa-web.pid"; }
fi

(( fail )) || rm -f "$qa_marker"   # a passing checkpoint ends the QA round
if (( fail )); then echo "checkpoint $label failed; see $log"; tail -n 25 "$log" | cut -c1-200; fi
exit "$fail"
