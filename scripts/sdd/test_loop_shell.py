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


if __name__ == '__main__':
    unittest.main()
