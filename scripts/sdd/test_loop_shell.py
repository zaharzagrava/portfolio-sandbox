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


if __name__ == '__main__':
    unittest.main()
