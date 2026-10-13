#!/usr/bin/env python3
"""select.py in a throwaway git repo: changed capability -> its charter runs; unchanged -> skipped; budget cuts the list; uncovered capabilities are listed."""
import os, shutil, subprocess, tempfile, unittest

SELECT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "select.py")


def sh(cwd, *cmd): subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})


class SelectTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(); sh(self.d, "git", "init", "-q")
        for p in ("docs/spec/capabilities", "scripts/qa/charters", "specs/.qa", "libs/a", "libs/b", "libs/c"): os.makedirs(os.path.join(self.d, p))
        shutil.copy(SELECT, os.path.join(self.d, "scripts/qa/select.py"))
        for cid, lib in (("S1", "a"), ("S2", "b"), ("S3", "c")):
            open(os.path.join(self.d, f"docs/spec/capabilities/{cid}-x.md"), "w").write(f"---\nid: {cid}\nscope:\n  - libs/{lib}/**\nstatus: draft\n---\n")
            open(os.path.join(self.d, f"libs/{lib}/f.ts"), "w").write("1")
        for name, spec in (("one", "S1"), ("two", "S2")):
            open(os.path.join(self.d, f"scripts/qa/charters/{name}.md"), "w").write(f"name: {name}\nspecs: {spec}\nminutes: 20\nbody\n")
        sh(self.d, "git", "add", "-A"); sh(self.d, "git", "commit", "-qm", "init")

    def run_select(self, *a): return subprocess.run(["python3", "scripts/qa/select.py", *a], cwd=self.d, capture_output=True, text=True).stdout.split()

    def test_never_run_charters_are_due_and_budget_cuts(self):
        self.assertEqual(sorted(self.run_select("--budget", "100")), ["one", "two"])
        self.assertEqual(len(self.run_select("--budget", "30")), 1)

    def test_charter_with_a_fresh_report_is_skipped_until_its_capability_changes(self):
        open(os.path.join(self.d, "specs/.qa/2090-01-01-0000-one.md"), "w").write("x")   # a report from the future: nothing is newer
        self.assertEqual(self.run_select("--budget", "100"), ["two"])

    def test_uncovered_capability_is_listed(self):
        self.assertEqual(self.run_select("--uncovered"), ["S3"])


if __name__ == "__main__": unittest.main()
