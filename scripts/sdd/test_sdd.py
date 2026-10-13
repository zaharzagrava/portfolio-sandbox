#!/usr/bin/env python3
"""Tests for the measurement and repair tooling of the build loop: python3 scripts/sdd/test_sdd.py
Covers report.py (a fixture jsonl), failures.py (fixture logs), the metric helpers in lib.sh, the checkpoint repair loop and the flake signal in
checkpoint-repair.sh (with a fake checkpoint and a fake repair step in a throwaway git repository), note-intervention.sh and the dry run."""
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, HERE)
import failures  # noqa: E402
import report  # noqa: E402


def read(path):
    with open(path) as f:
        return f.read()


def ev(run, cap, step, start, secs, result='ok', attempt=1, reason='', **extra):
    import datetime
    s = datetime.datetime.strptime(start, '%Y-%m-%dT%H:%M:%SZ')
    e = s + datetime.timedelta(seconds=secs)
    d = dict(run=run, capability=cap, step=step, start=start, end=e.strftime('%Y-%m-%dT%H:%M:%SZ'), seconds=secs, result=result, attempt=attempt, reason=reason)
    d.update(extra)
    return json.dumps(d)


A, B = '20261010T100000Z', '20261011T100000Z'
FIXTURE = [
    ev(A, '-', 'run-start', '2026-10-10T10:00:00Z', 0, reason='commit=abc1234 MAX_GATE_REPAIRS=3 MAX_REPAIRS_PER_SPEC=3'),
    ev(A, 'S13', 'plan', '2026-10-10T10:00:00Z', 60), ev(A, 'S13', 'tasks', '2026-10-10T10:01:00Z', 60),
    ev(A, 'S13', 'implement-1', '2026-10-10T10:02:00Z', 600), ev(A, 'S13', 'implement-2', '2026-10-10T10:12:00Z', 300),
    ev(A, 'S13', 'gate', '2026-10-10T10:17:00Z', 400, 'fail', 1, 'FAIL libs/domains/orders/x.e2e-spec.ts'),
    ev(A, 'S13', 'repair-1', '2026-10-10T10:24:00Z', 200, code_changed=True),
    ev(A, 'S13', 'gate', '2026-10-10T10:28:00Z', 400, 'fail', 2, 'error TS2322'),
    ev(A, 'S13', 'repair-2', '2026-10-10T10:35:00Z', 200, code_changed=True),
    ev(A, 'S13', 'gate', '2026-10-10T10:39:00Z', 400, 'pass', 3),
    ev(A, 'S13', 'built', '2026-10-10T10:00:00Z', 2400, reason='Orders'),
    ev(A, 'S14', 'implement-1', '2026-10-10T11:00:00Z', 500),
    ev(A, 'S14', 'gate', '2026-10-10T11:08:00Z', 300, 'fail', 1, 'FAIL web'),
    ev(A, 'S14', 'repair-1', '2026-10-10T11:13:00Z', 100, code_changed=False),
    ev(A, 'S14', 'gate', '2026-10-10T11:15:00Z', 300, 'pass', 2),          # no "flake" key: derived (the repair changed no code)
    ev(A, 'S14', 'built', '2026-10-10T11:00:00Z', 1300),
    ev(A, 'checkpoint:buy-ui', 'checkpoint', '2026-10-10T12:00:00Z', 900, 'fail', 1, 'Charge flow > creates the payment'),
    ev(A, 'checkpoint:buy-ui', 'ckrepair-buy-ui-1', '2026-10-10T12:15:00Z', 300, code_changed=True),
    ev(A, 'checkpoint:buy-ui', 'checkpoint', '2026-10-10T12:20:00Z', 900, 'pass', 2),
    ev(A, 'S14', 'intervention', '2026-10-10T13:00:00Z', 0, 'noted', 1, 'found by hand: payment stays PENDING'),
    ev(A, '-', 'intervention', '2026-10-10T13:05:00Z', 0, 'noted', 1, 'restarted the docker stack'),
    '{"broken json',
    ev(B, '-', 'run-start', '2026-10-11T10:00:00Z', 0, reason='commit=def5678 MAX_GATE_REPAIRS=5 MAX_REPAIRS_PER_SPEC=3'),
    ev(B, 'S15', 'implement-1', '2026-10-11T10:00:00Z', 400),
    ev(B, 'S15', 'gate', '2026-10-11T10:07:00Z', 300, 'pass', 1),
    ev(B, 'S15', 'built', '2026-10-11T10:00:00Z', 700),
    ev(B, 'S16', 'implement-1', '2026-10-11T11:00:00Z', 400, 'fail', 1, 'usage-limit'),
    ev(B, 'S16', 'gate', '2026-10-11T11:10:00Z', 300, 'fail', 1, 'FAIL x'),
    ev(B, 'S16', 'repair-1', '2026-10-11T11:15:00Z', 100, code_changed=False),
    ev(B, 'S16', 'gate', '2026-10-11T11:17:00Z', 300, 'pass', 2, flake=True),
    ev(B, 'S16', 'built', '2026-10-11T11:00:00Z', 1000),
    ev(B, 'S17', 'blocked', '2026-10-11T12:00:00Z', 0, 'blocked', 3, 'analyze reported CRITICAL issues'),
]


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, 'steps.jsonl')
        with open(self.path, 'w') as f:
            f.write('\n'.join(FIXTURE) + '\n')
        self.events, self.bad = report.load(self.path)
        self.caps, self.cks, self.ints, self.runs = report.analyse(self.events)

    def tearDown(self):
        self.tmp.cleanup()

    def test_unreadable_lines_are_counted_not_fatal(self):
        self.assertEqual(self.bad, 1)

    def test_per_capability_counts(self):
        s13 = self.caps['S13']
        self.assertEqual((s13['implement'], s13['repairs'], s13['gate_fail'], s13['gate_pass'], s13['flakes'], s13['built']), (2, 2, 2, 1, 0, True))
        self.assertEqual(s13['seconds'], 60 + 60 + 600 + 300 + 400 + 200 + 400 + 200 + 400)  # steps only, not the "built" wall time

    def test_a_gate_that_passed_after_a_repair_that_changed_no_code_is_a_flake(self):
        self.assertEqual(self.caps['S14']['flakes'], 1)      # derived from the order of events
        self.assertEqual(self.caps['S16']['flakes'], 1)      # recorded by the loop
        self.assertEqual(self.caps['S15']['flakes'], 0)
        self.assertEqual(self.caps['S14']['repairs_no_code'], 1)

    def test_repairs_that_changed_code_do_not_make_a_flake(self):
        self.assertEqual(self.caps['S13']['flakes'], 0)

    def test_checkpoints_and_interventions(self):
        ck = self.cks['buy-ui']
        self.assertEqual((ck['fail'], ck['passed'], ck['repairs']), (1, 1, 1))
        self.assertEqual(len(self.ints), 2)
        self.assertEqual(self.caps['S14']['hand'], 1)

    def test_blocked_capability(self):
        self.assertTrue(self.caps['S17']['blocked'])
        self.assertIn('CRITICAL', self.caps['S17']['blocked_why'])

    def test_trend_shows_a_changed_setting(self):
        text = report.render(self.events, self.bad, 'steps.jsonl', '2026-10-13')
        self.assertIn('settings changed since the previous run: MAX_GATE_REPAIRS 3 -> 5', text)
        self.assertIn(f'run {A}', text)
        self.assertIn(f'run {B}', text)

    def test_trend_compares_the_latest_run_per_built_capability(self):
        text = report.render(self.events, self.bad, 'steps.jsonl', '2026-10-13')
        self.assertIn('- repairs: 0.5 (before 1.5), down', text)    # run B: 1 repair / 2 built; run A: 3 / 2
        self.assertIn('- flakes: 0.5 (before 0.5), same', text)

    def test_report_is_lists_only_and_complete(self):
        text = report.render(self.events, self.bad, 'steps.jsonl', '2026-10-13')
        self.assertFalse([ln for ln in text.split('\n') if ln.startswith('|')], 'no tables')
        for heading in ('## Totals', '## Per capability', '### S13', '## Checkpoints', '## Interventions', '## Trend over runs'):
            self.assertIn(heading, text)
        self.assertIn('- gate: 1 passed, 2 failed; first reasons: FAIL libs/domains/orders/x.e2e-spec.ts; error TS2322', text)
        self.assertIn('- flakes: 1', text)
        self.assertIn('found by hand: payment stays PENDING', text)
        self.assertIn('(1 unreadable lines skipped)', text)

    def test_main_writes_docs_reports_date_md(self):
        out = os.path.join(self.tmp.name, 'reports')
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = report.main(['--input', self.path, '--out-dir', out, '--date', '2026-10-13'])
        self.assertEqual(rc, 0)
        self.assertTrue(os.path.exists(os.path.join(out, '2026-10-13.md')))
        self.assertTrue(buf.getvalue().strip().endswith('2026-10-13.md'))

    def test_missing_input_is_an_error_not_a_crash(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc = report.main(['--input', os.path.join(self.tmp.name, 'nope.jsonl'), '--out-dir', self.tmp.name])
        self.assertEqual(rc, 1)
        self.assertIn('no metrics yet', err.getvalue())

    def test_duration_format(self):
        self.assertEqual([report.dur(x) for x in (45, 125, 1500, 3700)], ['45s', '2m 05s', '25m', '1h 01m'])


JEST_LOG = """
  backend e2e sweep: suites 1-12 of 30
FAIL libs/domains/payments/charge.e2e-spec.ts (12.3 s)
  ● Charge flow › creates the payment

    expect(received).toBe(expected)

    Expected: "PAID"
    Received: "PENDING"
      at Object.<anonymous> (libs/domains/payments/charge.e2e-spec.ts:40:5)
      at Promise.then.completed (node_modules/jest-circus/build/utils.js:298:28)

FAIL libs/domains/legacy/old.e2e-spec.ts
  ● Old feature › still works

    Expected: 1

  ● Test suite failed to run

    Cannot find module 'x'
PASS libs/domains/orders/ok.e2e-spec.ts
Test Suites: 2 failed, 10 passed, 12 total
not counted (no built capability in domain "legacy"): libs/domains/legacy/old.e2e-spec.ts
FAILED: libs/domains/payments/charge.e2e-spec.ts
  web sweep FAILED
a sweep batch ended without a summary (1 of 3): the process crashed
"""

PW_LOG = """
  ✘  3 [chromium] › tests/cart.spec.ts:12:3 › JC-2 buy a product (30.1s)
  1) [chromium] › tests/cart.spec.ts:12:3 › JC-2 buy a product ─────────────────────

    Error: expect(locator).toBeVisible() failed

    Locator: getByText('Order confirmed')
    Error Context: test-results/cart-JC-2-chromium/error-context.md

  2) [chromium] › tests/cart.spec.ts:12:3 › JC-2 buy a product (retry #1) ─────────

    Error: expect(locator).toBeVisible() failed

  2 failed
    [chromium] › tests/cart.spec.ts:12:3 › JC-2 buy a product ──
    [chromium] › tests/search.spec.ts:5:3 › search no horizontal scroll at 320 px ──
  8 passed (1.2m)
"""


class FailuresTests(unittest.TestCase):
    def test_names_from_jest_skips_domains_the_sweep_does_not_count(self):
        names = failures.names(JEST_LOG)
        self.assertIn('Charge flow › creates the payment', names)
        self.assertNotIn('Old feature › still works', names)
        self.assertFalse([n for n in names if 'legacy' in n], names)
        self.assertIn('a sweep batch ended without a summary (1 of 3): the process crashed', names)

    def test_names_from_playwright_are_deduplicated_across_retries(self):
        names = failures.names(PW_LOG)
        self.assertEqual(names.count('[chromium] › tests/cart.spec.ts:12:3 › JC-2 buy a product'), 1)

    def test_colors_are_stripped(self):
        self.assertIn('Charge flow › creates the payment', failures.names('\x1b[31mFAIL\x1b[0m libs/a.e2e-spec.ts\n  \x1b[1m● Charge flow › creates the payment\x1b[0m\n'))

    def test_tsc_errors(self):
        n = failures.names('src/a.ts(3,4): error TS2322: Type string is not assignable to number.\n')
        self.assertEqual(n, ['tsc: src/a.ts(3,4): TS2322 Type string is not assignable to number.'])

    def test_a_suite_that_failed_to_run_is_named_by_its_path(self):
        n = failures.names('FAIL libs/a.e2e-spec.ts\n  ● Test suite failed to run\n\n    Cannot find module\n')
        self.assertEqual(n, ['libs/a.e2e-spec.ts: suite failed to run'])

    def test_digest_has_failures_details_and_no_node_modules_frames(self):
        d = failures.digest(JEST_LOG, 'buy-ui')
        self.assertIn('Checkpoint buy-ui failed.', d)
        self.assertIn('- libs/domains/payments/charge.e2e-spec.ts', d)
        self.assertIn('Expected: "PAID"', d)
        self.assertNotIn('node_modules/jest-circus', d.split('--- the last lines')[0])   # the raw tail may show them; the digest proper must not
        self.assertIn('not counted', d)
        self.assertIn('--- the last lines of the checkpoint log ---', d)

    def test_digest_includes_page_snapshots(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = os.path.join(tmp, 'test-results', 'cart-JC-2-chromium')
            os.makedirs(ctx)
            with open(os.path.join(ctx, 'error-context.md'), 'w') as f:
                f.write('# Page snapshot\n- heading "Payment is being processed…"\n')
            d = failures.digest(PW_LOG, 'buy-ui', os.path.join(tmp, 'test-results'), base=tmp)
            self.assertIn('error-context.md', d)
            self.assertIn('Payment is being processed…', d)

    def test_digest_is_bounded(self):
        big = JEST_LOG + '\n'.join(f'FAIL libs/domains/payments/s{i}.e2e-spec.ts\n  ● t{i} › x\n    Expected: {"y" * 150}' for i in range(300))
        self.assertLessEqual(len(failures.digest(big, 'x', max_chars=6000)), 6000)

    def test_flake_note_heading_once_then_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            gaps = os.path.join(tmp, 'gaps.md')
            with open(gaps, 'w') as f:
                f.write('# Gaps\n\n## Gate repairs\n- did x\n')
            log = os.path.join(tmp, 'g.log')
            with open(log, 'w') as f:
                f.write(JEST_LOG)
            failures.main(['flake-note', log, '--label', 'S13 gate', '--append', gaps, '--date', '2026-10-13'])
            failures.main(['flake-note', log, '--label', 'S13 gate', '--append', gaps, '--date', '2026-10-14'])
            text = read(gaps)
            self.assertEqual(text.count(failures.FLAKE_HEADING), 1)
            self.assertIn('- 2026-10-13 S13 gate: failed, then passed after a repair attempt that changed no code', text)
            self.assertIn('- 2026-10-14 S13 gate', text)
            self.assertIn('  - Charge flow › creates the payment', text)
            self.assertIn('## Gate repairs\n- did x', text)  # existing sections untouched

    def test_flake_note_inserted_before_a_following_heading(self):
        with tempfile.TemporaryDirectory() as tmp:
            gaps = os.path.join(tmp, 'gaps.md')
            with open(gaps, 'w') as f:
                f.write(f'# Gaps\n\n{failures.FLAKE_HEADING}\n- old entry\n\n## Later section\ntext\n')
            failures.append_flake(gaps, '- new entry')
            text = read(gaps)
            self.assertLess(text.index('- new entry'), text.index('## Later section'))
            self.assertTrue(text.endswith('## Later section\ntext\n'))


class ShellFixture(unittest.TestCase):
    """A throwaway git repository with copies of the real scripts and a fake checkpoint.sh."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fix = self.tmp.name
        for rel in ('scripts/sdd', 'packages', 'specs/.checkpoints', 'specs/domains/S13-x'):
            os.makedirs(os.path.join(self.fix, rel), exist_ok=True)
        for f in ('lib.sh', 'checkpoint-repair.sh', 'failures.py'):
            shutil.copy(os.path.join(HERE, f), os.path.join(self.fix, 'scripts', 'sdd', f))
        with open(os.path.join(self.fix, 'scripts', 'sdd', 'checkpoint.sh'), 'w') as f:
            f.write('''#!/usr/bin/env bash
top="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
n=$(( $(cat "$top/count" 2>/dev/null || echo 0) + 1 )); echo $n > "$top/count"   # outside scripts/ and packages/: it must not look like a code change
log="$top/specs/.checkpoints/$1.log"
if (( n <= ${FAIL_TIMES:-0} )); then
  printf 'FAIL libs/domains/payments/charge.e2e-spec.ts\\n  ● Charge flow › creates the payment\\n\\n    Expected: "PAID"\\n' > "$log"; exit 1
fi
: > "$log"; exit 0
''')
        os.chmod(os.path.join(self.fix, 'scripts', 'sdd', 'checkpoint.sh'), 0o755)
        with open(os.path.join(self.fix, 'packages', 'x.txt'), 'w') as f:
            f.write('code\n')
        with open(os.path.join(self.fix, 'specs/domains/S13-x/gaps.md'), 'w') as f:
            f.write('# Gaps\n')
        subprocess.run(['git', 'init', '-q', self.fix], check=True)

    def tearDown(self):
        self.tmp.cleanup()

    def bash(self, body, **env):
        e = dict(os.environ, NOTIFY_DRY='1', **env)
        e.pop('SDD_METRICS_DIR', None)
        script = f'''set -uo pipefail
ROOT={self.fix}; STATE_FILE={self.fix}/state
source {self.fix}/scripts/sdd/lib.sh
source {self.fix}/scripts/sdd/checkpoint-repair.sh
step() {{ # fake repair step: records the prompt, changes code if asked, answers
  local t0 fp0; t0=$(date +%s); fp0="$(code_fingerprint)"
  printf '%s' "$3" > "{self.fix}/prompt.$2.txt"
  [[ -n "${{REPAIR_CHANGES:-}}" ]] && echo changed >> "{self.fix}/packages/x.txt"
  echo "CHECKPOINT-REPAIR: ${{REPAIR_ANSWER:-fixed}}" > "$1/.$2.log"
  step_metric "$1" "$2" "$t0" 0 1 "$fp0"
  return 0
}}
{body}
'''
        return subprocess.run(['bash', '-c', script], capture_output=True, text=True, env=e)

    def metrics(self):
        p = os.path.join(self.fix, '.sdd-metrics', 'steps.jsonl')
        return [json.loads(x) for x in read(p).splitlines()] if os.path.exists(p) else []


class MetricHelperTests(ShellFixture):
    def test_every_line_is_valid_json_even_with_hostile_text(self):
        r = self.bash('''metric_step S13 gate 1760000000 1760000100 fail 2 'FAIL "q" \\ back
second line \x1b[31m red' '"flake":true'
metric_step - run-start 1760000000 1760000000 ok 1 "MAX_GATE_REPAIRS=5"''')
        self.assertEqual(r.returncode, 0, r.stderr)
        m = self.metrics()
        self.assertEqual(len(m), 2)
        self.assertEqual((m[0]['capability'], m[0]['step'], m[0]['result'], m[0]['attempt'], m[0]['seconds'], m[0]['flake']), ('S13', 'gate', 'fail', 2, 100, True))
        self.assertEqual(m[0]['start'], '2025-10-09T08:53:20Z')
        self.assertIn('"q"', m[0]['reason'])
        self.assertTrue(m[0]['run'])
        self.assertEqual(m[1]['reason'], 'MAX_GATE_REPAIRS=5')

    def test_a_metrics_failure_never_fails_the_loop(self):
        r = self.bash('SDD_METRICS_DIR=/proc/nonexistent/x; metric_step S1 gate 1 2 ok 1 x; echo survived')
        self.assertIn('survived', r.stdout)

    def test_step_outcome_maps_exit_codes_and_logs(self):
        log = os.path.join(self.fix, 'l.log')
        with open(log, 'w') as f:
            f.write('You have hit your usage limit. resets 5pm\n')
        r = self.bash(f'step_outcome 0 {log}; step_outcome 124 {log}; step_outcome 125 {log}; step_outcome 1 {log}; step_outcome 1 /dev/null')
        self.assertEqual(r.stdout.split('\n')[:5], ['ok ok', 'timeout pass-timeout', 'stopped deadline', 'fail usage-limit', 'fail crash-exit-1'])

    def test_code_fingerprint_changes_with_code_not_with_specs(self):
        r = self.bash(f'''a=$(code_fingerprint); echo more >> "{self.fix}/specs/domains/S13-x/gaps.md"; b=$(code_fingerprint)
echo more >> "{self.fix}/packages/x.txt"; c=$(code_fingerprint); echo "$a $b $c"''')
        a, b, c = r.stdout.split()
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)

    def test_note_intervention_script_appends_a_line(self):
        d = os.path.join(self.fix, 'm')
        r = subprocess.run([os.path.join(HERE, 'note-intervention.sh'), 'found by hand: "x" stuck', 'S48'], capture_output=True, text=True, env=dict(os.environ, SDD_METRICS_DIR=d))
        self.assertEqual(r.returncode, 0, r.stderr)
        line = json.loads(read(os.path.join(d, 'steps.jsonl')))
        self.assertEqual((line['capability'], line['step'], line['result'], line['reason']), ('S48', 'intervention', 'noted', 'found by hand: "x" stuck'))
        events, _ = report.load(os.path.join(d, 'steps.jsonl'))
        self.assertEqual(report.analyse(events)[2][0]['text'], 'found by hand: "x" stuck')


class CheckpointRepairTests(ShellFixture):
    def run_loop(self, **env):
        return self.bash('checkpoint_with_repair buy-ui; echo "rc=$?"', **env)

    def prompts(self):
        return sorted(f for f in os.listdir(self.fix) if f.startswith('prompt.'))

    def test_passing_checkpoint_needs_no_repair(self):
        r = self.run_loop(FAIL_TIMES='0')
        self.assertIn('rc=0', r.stdout, r.stderr)
        self.assertEqual(self.prompts(), [])
        self.assertEqual([(m['step'], m['result']) for m in self.metrics()], [('checkpoint', 'pass')])

    def test_failed_checkpoint_goes_to_the_repair_agent_with_the_failing_tests(self):
        r = self.run_loop(FAIL_TIMES='1', REPAIR_CHANGES='1')
        self.assertIn('rc=0', r.stdout, r.stdout + r.stderr)
        self.assertEqual(self.prompts(), ['prompt.ckrepair-buy-ui-1.txt'])
        prompt = read(os.path.join(self.fix, self.prompts()[0]))
        self.assertIn("checkpoint 'buy-ui' FAILED (repair attempt 1 of 5)", prompt)
        self.assertIn('Charge flow › creates the payment', prompt)
        self.assertIn('CHECKPOINT-REPAIR: fixed', prompt)
        steps = [(m['step'], m['result'], m.get('code_changed'), m.get('flake')) for m in self.metrics()]
        self.assertEqual(steps, [('checkpoint', 'fail', None, None), ('ckrepair-buy-ui-1', 'ok', True, None), ('checkpoint', 'pass', None, None)])
        self.assertFalse(os.path.exists(os.path.join(self.fix, 'specs/.checkpoints/buy-ui.flakes.md')))

    def test_pass_after_a_repair_that_changed_no_code_is_recorded_as_a_flake(self):
        r = self.run_loop(FAIL_TIMES='1')
        self.assertIn('rc=0', r.stdout, r.stdout + r.stderr)
        flakes = read(os.path.join(self.fix, 'specs/.checkpoints/buy-ui.flakes.md'))
        self.assertIn(failures.FLAKE_HEADING, flakes)
        self.assertIn('Charge flow › creates the payment', flakes)
        self.assertIn('checkpoint buy-ui: Charge flow', read(os.path.join(self.fix, 'state.flakes')))
        last = self.metrics()[-1]
        self.assertEqual((last['step'], last['result'], last.get('flake')), ('checkpoint', 'pass', True))
        self.assertIn('NOTIFY[info]', r.stdout)

    def test_attempts_are_bounded(self):
        r = self.run_loop(FAIL_TIMES='99', REPAIR_CHANGES='1', MAX_CHECKPOINT_REPAIRS='2')
        self.assertIn('rc=1', r.stdout, r.stdout + r.stderr)
        self.assertEqual(len(self.prompts()), 2)
        self.assertEqual(read(os.path.join(self.fix, 'count')).strip(), '3')   # 1 run + 2 reruns, then it gives up

    def test_attempt_limit_defaults_to_the_gate_limit(self):
        r = self.run_loop(FAIL_TIMES='99', REPAIR_CHANGES='1', MAX_GATE_REPAIRS='1')
        self.assertIn('rc=1', r.stdout)
        self.assertEqual(len(self.prompts()), 1)

    def test_agent_that_needs_a_human_stops_the_loop(self):
        r = self.run_loop(FAIL_TIMES='99', REPAIR_ANSWER='needs human: the payment sandbox key is missing')
        self.assertIn('rc=1', r.stdout)
        self.assertIn('needs human: the payment sandbox key is missing', r.stdout)
        self.assertEqual(len(self.prompts()), 1)

    def test_used_up_repair_budget_means_no_repair(self):
        r = self.bash('REPAIR_USED=3590; checkpoint_with_repair buy-ui; echo "rc=$?"', FAIL_TIMES='99')
        self.assertIn('rc=1', r.stdout)
        self.assertIn('repair budget is used up', r.stdout)
        self.assertEqual(self.prompts(), [])


class GateFlakeTests(ShellFixture):
    def gate(self, change_code):
        d = os.path.join(self.fix, 'specs/domains/S13-x')
        with open(os.path.join(d, '.gate.log'), 'w') as f:
            f.write(JEST_LOG)
        return self.bash(f'''GATE_FP=""; d="{d}"
g0=$(date +%s); gate_failed S13 "$d" "$g0" 1
{'echo changed >> "' + self.fix + '/packages/x.txt"' if change_code else ':'}
gate_passed S13 "$d" "$g0" 2''')

    def test_gate_that_passes_with_no_code_change_is_a_flake(self):
        r = self.gate(False)
        self.assertEqual(r.returncode, 0, r.stderr)
        gaps = read(os.path.join(self.fix, 'specs/domains/S13-x/gaps.md'))
        self.assertIn(failures.FLAKE_HEADING, gaps)
        self.assertIn('Charge flow › creates the payment', gaps)
        self.assertEqual([(m['result'], m.get('flake')) for m in self.metrics()], [('fail', None), ('pass', True)])
        self.assertTrue(os.path.exists(os.path.join(self.fix, 'specs/domains/S13-x/.gate.first-fail.log')))
        self.assertIn('S13 gate', read(os.path.join(self.fix, 'state.flakes')))

    def test_gate_that_passes_after_a_code_change_is_a_fix(self):
        r = self.gate(True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn(failures.FLAKE_HEADING, read(os.path.join(self.fix, 'specs/domains/S13-x/gaps.md')))
        self.assertEqual([(m['result'], m.get('flake')) for m in self.metrics()], [('fail', None), ('pass', None)])

    def test_gate_reason_is_the_first_explaining_line(self):
        log = os.path.join(self.fix, 'g.log')
        with open(log, 'w') as f:
            f.write('noise\nFAIL libs/domains/payments/charge.e2e-spec.ts (3 s)\nFAIL other\n')
        r = self.bash(f'gate_reason {log}')
        self.assertEqual(r.stdout.strip(), 'FAIL libs/domains/payments/charge.e2e-spec.ts (3 s)')


class DryRunTests(unittest.TestCase):
    def test_dry_run_prints_the_plan_and_the_prompt_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, 'ck.log')
            with open(log, 'w') as f:
                f.write(JEST_LOG)
            before = (os.path.exists(os.path.join(ROOT, '.sdd-metrics')), sorted(os.listdir(os.path.join(ROOT, 'specs'))) if os.path.isdir(os.path.join(ROOT, 'specs')) else [])
            r = subprocess.run([os.path.join(HERE, 'checkpoint-repair.sh'), '--dry-run', 'buy-ui', '--log', log, '--results-dir', os.path.join(tmp, 'none')],
                               capture_output=True, text=True, env=dict(os.environ, MAX_GATE_REPAIRS='4'))
            after = (os.path.exists(os.path.join(ROOT, '.sdd-metrics')), sorted(os.listdir(os.path.join(ROOT, 'specs'))) if os.path.isdir(os.path.join(ROOT, 'specs')) else [])
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(before, after)
            out = r.stdout
            self.assertIn("DRY RUN for checkpoint 'buy-ui'", out)
            self.assertIn('up to 4 repair attempts', out)
            self.assertIn('Charge flow › creates the payment', out)
            self.assertIn("(repair attempt 1 of 4)", out)
            self.assertIn('CHECKPOINT-REPAIR: needs human', out)
            self.assertIn('Known failure classes', out)   # the lessons digest is in the prompt

    def test_dry_run_without_a_log_still_works(self):
        r = subprocess.run([os.path.join(HERE, 'checkpoint-repair.sh'), '--dry-run', 'nolog', '--log', '/nonexistent/x.log'], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('No log at', r.stdout)

    def test_no_arguments_prints_usage(self):
        r = subprocess.run([os.path.join(HERE, 'checkpoint-repair.sh')], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)

    def test_scripts_parse(self):
        for f in ('lib.sh', 'implement-specs.sh', 'checkpoint-repair.sh', 'note-intervention.sh', 'checkpoint.sh'):
            self.assertEqual(subprocess.run(['bash', '-n', os.path.join(HERE, f)]).returncode, 0, f)

    def test_the_loop_is_wired_to_the_new_pieces(self):
        src = read(os.path.join(HERE, 'implement-specs.sh'))
        for needle in ('source "$ROOT/scripts/sdd/checkpoint-repair.sh"', 'if ! checkpoint_with_repair "$domain"', 'gate_passed "$id"', 'gate_failed "$id"',
                       'step_metric "$1" "$2" "$t0" "$rc" "$try" "$fp0"', 'metric_step "$id" built', 'run-start'):
            self.assertIn(needle, src)


if __name__ == '__main__':
    unittest.main()
