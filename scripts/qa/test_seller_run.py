#!/usr/bin/env python3
"""Tests of scripts/qa/seller-run.sh and scripts/qa/guard-tests.sh without any agent, server or docker: a fake explorer, a fake fixer and a fake curl
on the PATH, a throwaway git repository. Run:  python3 scripts/qa/test_seller_run.py"""
import os, stat, subprocess, tempfile, unittest

SRC = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True, cwd=os.path.dirname(os.path.abspath(__file__))).stdout.strip()
RUN, GUARD = os.path.join(SRC, 'scripts/qa/seller-run.sh'), os.path.join(SRC, 'scripts/qa/guard-tests.sh')
GIT_ENV = {'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'}
CHARTERS = ['shop-setup', 'products', 'photos', 'video', 'inventory-stock', 'bulk-import', 'team', 'developers', 'orders', 'overview-live']


def write(path, text, exe=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write(text)
    if exe:
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)


def git(cwd, *a):
    return subprocess.run(['git', *a], cwd=cwd, capture_output=True, text=True, env={**os.environ, **GIT_ENV})


class Base(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp()
        self.repo = os.path.join(self.t, 'repo')
        os.makedirs(self.repo)
        git(self.repo, 'init', '-q', '-b', 'master')
        write(f'{self.repo}/packages/web/tests/a.spec.ts', "test('A one', async () => {\n  expect(1).toBe(1)\n  expect(a).toBeLessThan(100)\n})\ntest('A two', async () => {\n  expect(2).toBe(2)\n})\n")
        write(f'{self.repo}/packages/web/src/app.ts', 'export const x = 1\n')
        git(self.repo, 'add', '-A'); git(self.repo, 'commit', '-qm', 'base')
        self.wt = os.path.join(self.t, 'repo-qa')
        self.charters = os.path.join(self.t, 'charters')
        for c in CHARTERS:
            write(f'{self.charters}/seller-{c}.md', f'name: seller-{c}\nspecs: S01\nminutes: 10\nDo things.\n')
        self.bin = os.path.join(self.t, 'bin')
        write(f'{self.bin}/curl', '#!/bin/sh\n[ -n "$FAKE_CURL_FAIL" ] && exit 22\nexit 0\n', exe=True)
        self.explorer = os.path.join(self.t, 'explorer.sh')
        write(self.explorer, '''#!/bin/bash
# fake run.sh: <charter> --minutes N --out DIR ; EXPLORER_FAIL_FIRST=1 makes the first call per charter leave no report
c="$1"; out="$5"; mkdir -p "$out"; n="$out/.calls-$c"; echo x >> "$n"
echo "$c called with: $*" >> "$out/.argv"
[ -n "$EXPLORER_ALWAYS_FAIL" ] && exit 3
[ -n "$EXPLORER_FAIL_FIRST" ] && [ "$(wc -l < "$n")" -lt 2 ] && exit 3
printf '# QA report: %s\\nDEFECT D1 CONFIRMED high: broken thing\\nDEFECT D2 SUSPICIOUS low: maybe\\n' "$c" > "$out/2026-10-24-1000-$c.md"
exit 1
''', exe=True)
        self.fixer = os.path.join(self.t, 'fixer.sh')
        write(self.fixer, '#!/bin/bash\nexit 0\n', exe=True)

    def run_it(self, *args, env=None, fixer=None):
        e = {**os.environ, **GIT_ENV, 'PATH': f'{self.bin}:{os.environ["PATH"]}', 'QA_REPO': self.repo, 'QA_WORKTREE': self.wt, 'QA_CHARTERS_DIR': self.charters,
             'QA_EXPLORE_CMD': self.explorer, 'QA_FIX_CMD': fixer or self.fixer, 'NOTIFY_DRY': '1', 'QA_RETRY_WAIT': '0', 'QA_WORKTREE_PATH': self.wt, **(env or {})}
        return subprocess.run(['bash', RUN, *args], capture_output=True, text=True, env=e, timeout=300)

    def results(self):
        rows = [l.split('\t') for l in open(f'{self.repo}/specs/.checkpoints/qa-seller/results.tsv').read().splitlines()]
        return {r[0]: r for r in rows[1:]}


class Runner(Base):
    def test_refuses_when_the_stack_does_not_answer(self):
        r = self.run_it('--only', 'team', env={'FAKE_CURL_FAIL': '1'})
        self.assertEqual(r.returncode, 2)
        self.assertIn('does not answer', r.stderr)
        self.assertFalse(os.path.exists(self.wt), 'no branch or working copy is made before the stack is known good')

    def test_list_shows_fixed_order_with_orders_and_overview_last_and_alone(self):
        r = self.run_it('--list')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('together (up to 3 at once): seller-shop-setup seller-products seller-photos seller-video seller-inventory-stock seller-bulk-import seller-team seller-developers', r.stdout)
        self.assertIn('alone, last, in this order: seller-orders seller-overview-live', r.stdout)

    def test_only_accepts_short_names_and_rejects_typos(self):
        self.assertIn('alone, last, in this order: seller-orders', self.run_it('--list', '--only', 'orders,photos').stdout)
        r = self.run_it('--list', '--only', 'potos')
        self.assertEqual(r.returncode, 2)
        self.assertIn('no such charter', r.stderr)

    def test_parallel_is_capped_at_three(self):
        self.assertIn('up to 3 at once', self.run_it('--list', '--parallel', '9').stdout)

    def test_a_run_makes_the_branch_a_results_table_and_leaves_master_alone(self):
        master0 = git(self.repo, 'rev-parse', 'master').stdout
        r = self.run_it('--only', 'photos,team,orders', '--no-fix')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        res = self.results()
        self.assertEqual(sorted(res), ['seller-orders', 'seller-photos', 'seller-team'])
        for row in res.values():
            self.assertEqual(row[3], 'done'); self.assertEqual(row[4], '1'); self.assertEqual(row[5], '0')   # one CONFIRMED, the SUSPICIOUS one is not counted
        self.assertEqual(git(self.repo, 'rev-parse', 'master').stdout, master0)
        self.assertEqual(git(self.wt, 'branch', '--show-current').stdout.strip(), 'qa/seller-dashboard')
        self.assertTrue(os.path.exists(f'{self.repo}/specs/.checkpoints/qa-seller/seller-photos.log'))
        self.assertIn('NOTIFY[ok] QA seller-photos', r.stdout)
        argv = open(f'{self.repo}/specs/.checkpoints/qa-seller/reports/.argv').read()
        self.assertIn('seller-photos called with: seller-photos --minutes 10 --out', argv)   # the time box comes from the charter

    def test_orders_run_after_the_parallel_ones(self):
        self.run_it('--only', 'photos,orders,overview-live', '--no-fix')
        order = [l.split()[0] for l in open(f'{self.repo}/specs/.checkpoints/qa-seller/results.tsv').read().splitlines()[1:]]
        self.assertEqual(order, ['seller-photos', 'seller-orders', 'seller-overview-live'])

    def test_a_crash_is_retried_once_then_marked_crashed(self):
        r = self.run_it('--only', 'team', '--no-fix', env={'EXPLORER_FAIL_FIRST': '1'})
        self.assertEqual(self.results()['seller-team'][3], 'done', r.stdout)
        calls = open(f'{self.repo}/specs/.checkpoints/qa-seller/reports/.calls-seller-team').read().split()
        self.assertEqual(len(calls), 2)
        r = self.run_it('--only', 'products', '--no-fix', env={'EXPLORER_ALWAYS_FAIL': '1', 'QA_RETRIES': '1'})
        self.assertEqual(self.results()['seller-products'][3], 'crashed')
        self.assertEqual(len(open(f'{self.repo}/specs/.checkpoints/qa-seller/reports/.calls-seller-products').read().split()), 2)
        self.assertIn('NOTIFY[fail] QA seller-products', r.stdout)

    def test_no_retry_when_retries_is_zero(self):
        self.run_it('--only', 'team', '--no-fix', env={'EXPLORER_ALWAYS_FAIL': '1', 'QA_RETRIES': '0'})
        self.assertEqual(len(open(f'{self.repo}/specs/.checkpoints/qa-seller/reports/.calls-seller-team').read().split()), 1)

    def test_a_spent_budget_runs_nothing_and_says_so(self):
        r = self.run_it('--only', 'team', '--no-fix', '--budget', '0')
        self.assertEqual(self.results()['seller-team'][3], 'not run (budget used)')
        self.assertIn('NOTIFY[limit]', r.stdout)

    def test_refuses_a_dirty_working_copy(self):
        self.run_it('--only', 'team', '--no-fix')
        write(f'{self.wt}/packages/web/src/app.ts', 'export const x = 2\n')
        r = self.run_it('--only', 'team', '--no-fix')
        self.assertEqual(r.returncode, 2)
        self.assertIn('uncommitted changes', r.stderr)

    def test_a_good_fix_commit_is_kept_and_logged_a_weakening_one_is_reverted(self):
        write(self.fixer, f'''#!/bin/bash
cd "{self.wt}"
echo 'export const x = 5' > packages/web/src/app.ts
git add -A && git commit -qm 'Fix the broken thing' -m 'Why: the value was wrong.
Defect: $1 D1
Test: A one'
sed -i 's/test(.A two./test.skip("A two"/' packages/web/tests/a.spec.ts
git add -A && git commit -qm 'Make it pass' -m 'Why: because'
''', exe=True)
        r = self.run_it('--only', 'team', fixer=self.fixer)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.results()['seller-team'][5], '1')
        changes = open(f'{self.repo}/specs/.checkpoints/qa-seller/changes.md').read()
        self.assertIn('Fix the broken thing', changes)
        self.assertIn('why: the value was wrong.', changes)
        self.assertIn('test: A one', changes)
        self.assertIn('REVERTED by the test guard', changes)
        self.assertIn('skipped test', changes)
        tests = open(f'{self.wt}/packages/web/tests/a.spec.ts').read()
        self.assertNotIn('.skip', tests)                                     # the revert put the test back
        self.assertEqual(open(f'{self.wt}/packages/web/src/app.ts').read(), 'export const x = 5\n')   # the good fix stays
        self.assertIn('Revert', git(self.wt, 'log', '--format=%s').stdout)

    def test_script_never_pushes_or_resets(self):
        text = open(RUN).read()
        code = [l for l in text.splitlines() if not l.lstrip().startswith('#') and 'prompt=' not in l and 'Never use git push' not in l]
        for word in ('push', 'reset --hard', 'branch -D', 'checkout master', 'switch master'):
            self.assertFalse([l for l in code if word in l], word)

    def test_syntax_and_stack_up_carries_the_video_check(self):
        for f in ('scripts/qa/seller-run.sh', 'scripts/qa/guard-tests.sh', 'scripts/qa/stack-up.sh'):
            self.assertEqual(subprocess.run(['bash', '-n', os.path.join(SRC, f)]).returncode, 0, f)
        up = open(os.path.join(SRC, 'scripts/qa/stack-up.sh')).read()
        self.assertIn('ffprobe', up); self.assertIn('video worker', up)


class Guard(Base):
    def commit(self, edits, msg='x'):
        for p, text in edits.items():
            write(f'{self.repo}/{p}', text)
        git(self.repo, 'add', '-A'); git(self.repo, 'commit', '-qm', msg)
        return git(self.repo, 'rev-parse', 'HEAD').stdout.strip()

    def guard(self, sha, env=None):
        return subprocess.run(['bash', GUARD, sha, self.repo], capture_output=True, text=True, env={**os.environ, **(env or {})})

    SPEC = 'packages/web/tests/a.spec.ts'

    def test_a_plain_fix_with_a_new_test_passes(self):
        sha = self.commit({'packages/web/src/app.ts': 'export const x = 2\n', self.SPEC: open(f'{self.repo}/{self.SPEC}').read() + "test('A three', async () => {\n  expect(3).toBe(3)\n})\n"})
        r = self.guard(sha); self.assertEqual(r.returncode, 0, r.stdout)

    def rejects(self, edits, word):
        r = self.guard(self.commit(edits)); self.assertEqual(r.returncode, 1, r.stdout); self.assertIn(word, r.stdout)

    def test_removed_test_is_rejected(self):
        self.rejects({self.SPEC: "test('A one', async () => {\n  expect(1).toBe(1)\n  expect(a).toBeLessThan(100)\n})\n"}, 'removes the test: A two')

    def test_skip_is_rejected(self):
        self.rejects({self.SPEC: open(f'{self.repo}/{self.SPEC}').read().replace("test('A two'", "test.skip('A two'")}, 'skipped test')

    def test_removed_expect_is_rejected(self):
        self.rejects({self.SPEC: open(f'{self.repo}/{self.SPEC}').read().replace('  expect(2).toBe(2)\n', '')}, 'removes expect(')

    def test_loosened_number_is_rejected(self):
        self.rejects({self.SPEC: open(f'{self.repo}/{self.SPEC}').read().replace('toBeLessThan(100)', 'toBeLessThan(5000)')}, 'raised a limit')

    def test_raised_timeout_is_rejected(self):
        self.commit({self.SPEC: "test('T', async () => {\n  await expect(p).toBeVisible({ timeout: 5000 })\n  expect(1).toBe(1)\n})\n" + open(f'{self.repo}/{self.SPEC}').read()})
        self.rejects({self.SPEC: open(f'{self.repo}/{self.SPEC}').read().replace('timeout: 5000', 'timeout: 60000')}, 'raised a limit')

    def test_settings_file_is_rejected(self):
        self.rejects({'packages/web/playwright.config.ts': 'export default { retries: 2 }\n'}, 'settings file')

    def test_too_many_files_or_lines_is_rejected(self):
        self.rejects({f'packages/web/src/f{i}.ts': 'a\n' for i in range(6)}, 'files (limit 5)')
        self.rejects({'packages/web/src/big.ts': ''.join(f'line {i}\n' for i in range(200))}, 'changed lines (limit 150)')

    def test_added_retries_is_rejected(self):
        self.rejects({self.SPEC: "test.describe.configure({ retries: 3 })\n" + open(f'{self.repo}/{self.SPEC}').read()}, 'retries')


if __name__ == '__main__':
    unittest.main()
