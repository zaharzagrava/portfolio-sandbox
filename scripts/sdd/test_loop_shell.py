#!/usr/bin/env python3
"""Two shell mistakes that stopped or blinded a cloud run on 2026-10-13, kept from coming back.
1. code_fingerprint() failed when a tracked file was deleted (xargs exits 123, pipefail, set -e): the whole loop ended instead of starting the repair agent.
2. A backtick inside the double-quoted prompt of extra_context() ran `[proof: ...]` as a command ("command not found") and dropped that instruction from every prompt."""
import os, re, subprocess, tempfile, unittest

ROOT = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True, cwd=os.path.dirname(os.path.abspath(__file__))).stdout.strip()


class LoopShell(unittest.TestCase):
    def test_code_fingerprint_survives_a_deleted_tracked_file(self):
        d = tempfile.mkdtemp()
        env = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'}
        for cmd in (['git', 'init', '-q'], ['sh', '-c', 'mkdir -p packages scripts && echo a > packages/a.ts && echo b > packages/b.ts'], ['git', 'add', '-A'], ['git', 'commit', '-qm', 'x'], ['rm', 'packages/a.ts']):
            subprocess.run(cmd, cwd=d, check=True, env=env)
        r = subprocess.run(['bash', '-c', f'set -euo pipefail; ROOT="{d}"; source "{ROOT}/scripts/sdd/lib.sh"; ROOT="{d}"; fp="$(code_fingerprint)"; echo "fp=$fp"; echo reached-the-next-line'],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('reached-the-next-line', r.stdout)

    def test_extra_context_keeps_the_backticked_text_and_runs_no_command(self):
        text = open(os.path.join(ROOT, 'scripts/sdd/implement-specs.sh'), encoding='utf-8').read()
        m = re.search(r'^extra_context\(\) \{.*?^\}', text, re.M | re.S)
        self.assertTrue(m)
        r = subprocess.run(['bash', '-c', f'set -euo pipefail; ROOT="{ROOT}"; LESSONS=""; UNATTENDED_RULES=x; decisions_to_apply() {{ :; }}; {m.group(0)}\nextra_context S01'], capture_output=True, text=True)
        self.assertNotIn('command not found', r.stderr)
        self.assertIn('[proof: ...]', r.stdout)
        self.assertIn('[code: ...]', r.stdout)

    def test_no_prompt_line_runs_a_backticked_word_as_a_command(self):
        """A backtick inside a double-quoted printf is command substitution: `--reporter=line` ran as a command on the runner (2026-10-14) and its text never reached the agent."""
        import glob
        bad = []
        for f in glob.glob(os.path.join(ROOT, 'scripts/sdd/*.sh')):
            for n, line in enumerate(open(f, encoding='utf-8'), 1):
                if ('printf' in line or 'echo "' in line) and not line.lstrip().startswith('#') and re.search(r'(?<!\\)`', line.replace("'```'", '')):
                    bad.append(f'{os.path.basename(f)}:{n}')
        self.assertEqual(bad, [], 'unescaped backticks in a double-quoted prompt: ' + ', '.join(bad))

    def test_every_agent_prompt_carries_the_unattended_rules(self):
        """2026-10-16: a repair agent started the 25-minute journey suite in the background and ended its turn; the result never reached it and the gate ran the suite again, five times, for four hours."""
        text = open(os.path.join(ROOT, 'scripts/sdd/implement-specs.sh'), encoding='utf-8').read()
        self.assertIn('Never start a command in the background', text)
        for fn in ('repair_prompt', 'doctor_prompt', 'extra_context'):
            m = re.search(r'^%s\(\) \{.*?^\}' % fn, text, re.M | re.S)
            self.assertTrue(m, fn)
            self.assertIn('UNATTENDED_RULES', m.group(0), fn)

    def test_converge_runtime_proof_tasks_are_deferred_not_looped(self):
        """J01 2026-10-16: converge added 'record the runtime proofs' after every pass, the agent could not run them, the doctor deferred them, converge added another."""
        import tempfile
        d = tempfile.mkdtemp()
        t, c = os.path.join(d, 'tasks.md'), os.path.join(d, 'deferred.md')
        open(t, 'w').write('- [ ] T080 HIGH: record the runtime proofs that T073 only deferred. Run `scripts/qa/fresh-run.sh --here`\n- [ ] T081 Fix the fresh-run.sh bug that kills the stack\n- [ ] T082 Run `pnpm test:journeys` and record the result\n- [ ] T083 HIGH: make AS-30 pass\n')
        r = subprocess.run(['python3', os.path.join(ROOT, 'scripts/sdd/defer-runtime.py'), t, 'J01', c], capture_output=True, text=True)
        self.assertEqual(r.stdout.split(), ['T080', 'T082'], r.stderr)
        left = [l for l in open(t).read().split('\n') if l.startswith('- [ ]')]
        self.assertEqual([l.split()[3] for l in left], ['T081', 'T083'])
        self.assertIn('J01 T080', open(c).read())
        r = subprocess.run(['python3', os.path.join(ROOT, 'scripts/sdd/defer-runtime.py'), t, 'J01', c], capture_output=True, text=True)
        self.assertEqual(r.stdout.strip(), '')

    def test_failures_names_survives_a_reader_that_closes_the_pipe(self):
        """S06 2026-10-17: `failures.py names big.log | head -3` died of a broken pipe (python exit 120) and, under set -e -o pipefail, ended the whole run."""
        import tempfile
        f = os.path.join(tempfile.mkdtemp(), 'big.log')
        open(f, 'w').write(''.join(f'  ● Suite {i} › S06 AS-{i}: something failed\n\n    boom\n\n' for i in range(20000)))
        r = subprocess.run(['bash', '-c', f'set -euo pipefail; n="$(python3 {ROOT}/scripts/sdd/failures.py names {f} | head -3 | tr "\\n" ";")"; echo survived'], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr[-300:])
        self.assertIn('survived', r.stdout)

    def test_staged_backend_gate_reruns_only_failures_then_everything_then_small_batches(self):
        """The user's rule: parts first, then only the failed ones, then everything, then (if that fails again) small batches."""
        import tempfile, textwrap
        d = tempfile.mkdtemp()
        env = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'}
        subprocess.run(['git', 'init', '-q'], cwd=d, check=True, env=env)
        os.makedirs(os.path.join(d, 'packages/backend'))
        os.makedirs(os.path.join(d, 'bin'))
        # a fake npx (Vitest): `vitest list --filesOnly` prints 6 spec files; `vitest run` writes a JSON report in which `bad-spec` files fail while $BAD is set
        open(os.path.join(d, 'bin/npx'), 'w').write(textwrap.dedent('''\
            #!/usr/bin/env bash
            if [[ " $* " == *" list "* ]]; then for n in a b c d e f; do echo "libs/domains/x/$n.e2e-spec.ts"; done; exit 0; fi
            out=""; files=(); for a in "$@"; do case "$a" in --outputFile.json=*) out="${a#*=}";; *.e2e-spec.ts) files+=("$a");; esac; done
            echo "RUN ${#files[@]} files: ${files[*]##*/}" >> "$LOG"
            python3 - "$out" "${files[@]}" <<'PY'
            import json, os, sys
            out, files = sys.argv[1], sys.argv[2:]
            bad = os.environ.get("BAD", "").split()
            res = [{"name": f, "status": "failed" if os.path.basename(f).split(".")[0] in bad else "passed"} for f in files]
            json.dump({"testResults": res}, open(out, "w"))
            sys.exit(1 if any(r["status"] == "failed" for r in res) else 0)
            PY
            '''))
        os.chmod(os.path.join(d, 'bin/npx'), 0o755)
        text = open(os.path.join(ROOT, 'scripts/sdd/implement-specs.sh'), encoding='utf-8').read()
        funcs = '\n'.join(re.search(r'^%s\(\) \{.*?^\}' % n, text, re.M | re.S).group(0) for n in ('gate_state', 'gate_fulls_failed', 'gate_full_failed', 'gate_reset', 'backend_run_specs', 'backend_gate'))
        funcs = '\n'.join(l for l in funcs.split('\n'))
        script = f'''set -uo pipefail; cd {d}; export ROOT={ROOT} PATH={d}/bin:$PATH LOG={d}/log; id=T; code_path() {{ echo libs/domains/x; }}
        {funcs}
        run() {{ echo "-- $1"; shift; "$@" >/dev/null 2>&1; echo "rc=$?" >> $LOG; }}
        export BAD="b e"; run "1 first run (parts of 4)" backend_gate x
        export BAD="e"; run "2 only the failed, still red" backend_gate x
        export BAD=""; run "3 failed pass, then everything" backend_gate x
        '''
        r = subprocess.run(['bash', '-c', script], capture_output=True, text=True, env=env)
        log = open(os.path.join(d, 'log')).read().split('\n')
        # first run: 6 files in parts of 12 = one process with all six, fails (b, e)
        self.assertEqual(log[0], 'RUN 6 files: a.e2e-spec.ts b.e2e-spec.ts c.e2e-spec.ts d.e2e-spec.ts e.e2e-spec.ts f.e2e-spec.ts', r.stderr[-500:])
        self.assertEqual(log[1], 'rc=1')
        # second attempt: only b and e; e still fails
        self.assertEqual(log[2], 'RUN 2 files: b.e2e-spec.ts e.e2e-spec.ts')
        self.assertEqual(log[3], 'rc=1')
        # third attempt: only the failed list (now just e), it passes; then everything, in batches of 4 because a full run failed before
        self.assertEqual(log[4], 'RUN 1 files: e.e2e-spec.ts')
        self.assertEqual(log[5], 'RUN 4 files: a.e2e-spec.ts b.e2e-spec.ts c.e2e-spec.ts d.e2e-spec.ts')
        self.assertEqual(log[6], 'RUN 2 files: e.e2e-spec.ts f.e2e-spec.ts')
        self.assertEqual(log[7], 'rc=0')

    def test_api_ready_waits_for_a_steady_answer(self):
        """The watch-mode API restarts after every edit; specs must not start in that window."""
        import http.server, threading, tempfile
        d = tempfile.mkdtemp(); os.makedirs(os.path.join(d, 'health')); open(os.path.join(d, 'health/ready'), 'w').write('ok')
        handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=d, **k)
        srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler); threading.Thread(target=srv.serve_forever, daemon=True).start()
        env = {**os.environ, 'API_URL': f'http://127.0.0.1:{srv.server_address[1]}', 'API_READY_WAIT_S': '30'}
        r = subprocess.run(['bash', os.path.join(ROOT, 'scripts/sdd/stack-fix.sh'), 'api-ready'], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr); self.assertIn('stable', r.stdout)
        srv.shutdown(); srv.server_close()
        r = subprocess.run(['bash', os.path.join(ROOT, 'scripts/sdd/stack-fix.sh'), 'api-ready'], capture_output=True, text=True, env={**env, 'API_READY_WAIT_S': '4'})
        self.assertEqual(r.returncode, 1); self.assertIn('not stable', r.stdout)

    def test_flaky_browser_tests_are_recorded_not_hidden(self):
        """PW_RETRIES=1 lets a flake pass on the retry; the gate must still list it."""
        import tempfile
        d = tempfile.mkdtemp()
        open(os.path.join(d, '.gate.log'), 'w').write('noise\n  2 flaky\n    [desktop] › tests/seller-live.spec.ts:8:7 › Seller live › W04 AS-19\n    [mobile] › tests/a.spec.ts:1:1 › x › y\n  454 passed (25.1m)\n')
        r = subprocess.run(['bash', '-c', f'source {ROOT}/scripts/sdd/checkpoint-repair.sh 2>/dev/null; flaky_specs_record W04 {d}'], capture_output=True, text=True)
        out = open(os.path.join(d, 'flaky-specs.md')).read()
        self.assertIn('seller-live.spec.ts:8:7', out); self.assertIn('tests/a.spec.ts', out); self.assertNotIn('454 passed', out)

    def test_unattended_rules_survive_bash_quoting(self):
        """2026-10-19: a single quote inside the single-quoted rules ended the string, bash ran a word of the text as a command, and the loop never started."""
        text = open(os.path.join(ROOT, 'scripts/sdd/implement-specs.sh'), encoding='utf-8').read()
        m = re.search(r"^UNATTENDED_RULES='.*?'\n", text, re.M | re.S)
        self.assertTrue(m)
        r = subprocess.run(['bash', '-c', m.group(0) + '\nprintf %s "$UNATTENDED_RULES"'], capture_output=True, text=True)
        self.assertEqual(r.stderr, '', r.stderr)
        for needle in ('wait-for.sh', 'Never start a command in the background', 'api-restart', 'Never answer needs human for that.'):
            self.assertIn(needle, r.stdout)
        # nothing may follow the closing quote on that line except a newline: no stray words that bash would run
        self.assertTrue(m.group(0).rstrip('\n').endswith("'"))

    def test_allow_list_names_every_helper_in_every_path_form(self):
        """J03 2026-10-19: an agent working in packages/backend writes ../../scripts/sdd/stack-fix.sh; a rule matches only up to a word boundary, so the script must be named."""
        text = open(os.path.join(ROOT, 'scripts/sdd/implement-specs.sh'), encoding='utf-8').read()
        i = text.index('IMPL_TOOLS=('); j = text.index('unset _root _f') + len('unset _root _f')
        r = subprocess.run(['bash', '-c', 'ROOT=/opt/sdd/repo; TEST_SPEC="$ROOT/scripts/sdd/test-spec.sh"\n' + text[i:j] + '\nprintf "%s\\n" "${IMPL_TOOLS[@]}"'], capture_output=True, text=True)
        self.assertEqual(r.stderr, '', r.stderr)
        tools = r.stdout.split('\n')
        for want in ('Bash(bash ../../scripts/sdd/wait-for.sh:*)', 'Bash(../../scripts/sdd/stack-fix.sh:*)', 'Bash(bash scripts/sdd/test-spec.sh:*)',
                     'Bash(python3 ../../scripts/livespec/check.py:*)', 'Bash(git diff:*)', 'Bash(python3:*)'):
            self.assertIn(want, tools)

    def test_checkpoint_progress_helpers(self):
        """Phone messages and progress lines of a checkpoint: buckets, one note per boundary, nothing for 100 percent (the verdict says that)."""
        script = f'''set -uo pipefail; export NOTIFY_DRY=1 ROOT={ROOT}; source {ROOT}/scripts/sdd/ckpt-progress.sh; ckpt_init final
        echo "b1=$(ckpt_bucket 59 593 10) b2=$(ckpt_bucket 60 593 10) b3=$(ckpt_bucket 593 593 10) b4=$(ckpt_bucket 5 0 10)"
        for d in 12 60 61 70 120 593; do ckpt_progress "backend e2e" $d 593 10 "2 failing suites so far"; done'''
        r = subprocess.run(['bash', '-c', script], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('b1=0 b2=10 b3=100 b4=0', r.stdout)
        notes = [l for l in r.stdout.split('\n') if 'backend e2e' in l and l.startswith('  [checkpoint')]
        self.assertEqual(len(notes), 2, r.stdout)   # 10% (60 suites) and 20% (120 suites); 12 is below 10%, 61 and 70 are the same boundary, 593 is 100%
        self.assertIn('backend e2e 10% (60 of 593), 2 failing suites so far', notes[0]); self.assertIn('backend e2e 20% (120 of 593)', notes[1])
        self.assertIn('NOTIFY[info] SDD checkpoint final:', r.stdout)

    def test_checkpoint_playwright_watcher_reads_the_list_reporter(self):
        import tempfile, time
        d = tempfile.mkdtemp(); log = os.path.join(d, 'web.log')
        open(log, 'w').write('Running 8 tests using 2 workers\n' + ''.join(f'  ✓   {i} [desktop] › tests/a.spec.ts:1:1 › t{i} (1.0s)\n' for i in range(1, 5)) + '  ✘   5 [desktop] › tests/b.spec.ts:2:2 › broken (3.0s)\n')
        script = f'''export NOTIFY_DRY=1 ROOT={ROOT}; source {ROOT}/scripts/sdd/ckpt-progress.sh; ckpt_init final
        sleep() {{ command sleep 0.2; }}; ckpt_watch_playwright {log} "browser sweep" 25 & p=$!; command sleep 1.5; kill $p; wait $p 2>/dev/null; true'''
        r = subprocess.run(['bash', '-c', script], capture_output=True, text=True, timeout=30)
        self.assertIn('browser sweep 50% (5 of 8), 1 failing so far', r.stdout, r.stdout + r.stderr)


if __name__ == '__main__':
    unittest.main()
