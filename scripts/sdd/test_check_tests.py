#!/usr/bin/env python3
"""check-tests.py integrity: a test may be replaced, split or deleted; a scenario may not disappear."""
import os, subprocess, tempfile, unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'check-tests.py')
ENV = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'}


def run(cwd, *cmd): return subprocess.run(cmd, cwd=cwd, check=True, env=ENV, capture_output=True, text=True)


class Integrity(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        run(self.d, 'git', 'init', '-q')
        os.makedirs(os.path.join(self.d, 'packages/x'))
        self.write('packages/x/old.e2e-spec.ts', "it('S34 AS-01 AS-13: journey', () => { expect(1).toBe(1); expect(2).toBe(2); });\n")
        self.write('packages/x/other.spec.ts', "it('S34 AS-05: other', () => { expect(1).toBe(1); });\n")
        self.write('packages/x/plain.spec.ts', "it('no scenario id', () => { expect(1).toBe(1); });\n")
        run(self.d, 'git', 'add', '-A'); run(self.d, 'git', 'commit', '-qm', 'base')

    def write(self, rel, text):
        os.makedirs(os.path.dirname(os.path.join(self.d, rel)), exist_ok=True)
        open(os.path.join(self.d, rel), 'w').write(text)

    def check(self):
        return subprocess.run(['python3', SCRIPT, 'integrity', 'packages/x'], cwd=self.d, capture_output=True, text=True)

    def test_replacing_a_test_file_with_new_ones_that_carry_its_scenarios_passes(self):
        os.remove(os.path.join(self.d, 'packages/x/old.e2e-spec.ts'))
        self.write('packages/x/read.e2e-spec.ts', "it('S34 AS-01: read', () => { expect(1).toBe(1); });\n")
        self.write('packages/x/cold.e2e-spec.ts', "it('S34 AS-13: cold start', () => { expect(1).toBe(1); });\n")
        r = self.check(); self.assertEqual(r.returncode, 0, r.stdout)

    def test_deleting_a_test_file_whose_scenario_is_in_no_other_test_fails_and_names_it(self):
        os.remove(os.path.join(self.d, 'packages/x/old.e2e-spec.ts'))
        self.write('packages/x/read.e2e-spec.ts', "it('S34 AS-01: read', () => { expect(1).toBe(1); });\n")
        r = self.check(); self.assertEqual(r.returncode, 1); self.assertIn('S34 AS-13', r.stdout)

    def test_a_scenario_retired_with_a_reason_may_go(self):
        os.remove(os.path.join(self.d, 'packages/x/old.e2e-spec.ts'))
        self.write('packages/x/read.e2e-spec.ts', "it('S34 AS-01: read', () => { expect(1).toBe(1); });\n")
        self.write('specs/domains/S34-x/retired-scenarios.md', "S34 AS-13: the cold start moved to the platform capability\n")
        r = self.check(); self.assertEqual(r.returncode, 0, r.stdout)

    def test_a_deleted_test_without_any_scenario_id_is_still_a_finding(self):
        os.remove(os.path.join(self.d, 'packages/x/plain.spec.ts'))
        r = self.check(); self.assertEqual(r.returncode, 1); self.assertIn('no scenario id', r.stdout)

    def test_adding_a_skip_is_still_a_finding(self):
        self.write('packages/x/other.spec.ts', "it.skip('S34 AS-05: other', () => { expect(1).toBe(1); });\n")
        r = self.check(); self.assertEqual(r.returncode, 1); self.assertIn('skipped', r.stdout)

    def test_an_env_gated_skip_is_not_an_added_skip(self):
        self.write('packages/x/other.spec.ts', "it('S34 AS-05: other', () => { test.skip(!process.env.SLOW_RUN, 'slow run only'); expect(1).toBe(1); });\n")
        r = self.check(); self.assertEqual(r.returncode, 0, r.stdout)

    def test_a_skip_with_another_condition_is_still_a_finding(self):
        self.write('packages/x/other.spec.ts', "it('S34 AS-05: other', () => { test.skip(true, 'off'); expect(1).toBe(1); });\n")
        r = self.check(); self.assertEqual(r.returncode, 1); self.assertIn('skipped', r.stdout)


if __name__ == '__main__': unittest.main()
