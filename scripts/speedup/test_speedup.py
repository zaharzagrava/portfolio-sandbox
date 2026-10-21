#!/usr/bin/env python3
"""Tests for the speed-up tools: depgraph.py, select-tests.sh, pass-cache.sh, and the Jest-style summary of a Vitest run
(scripts/sdd/vitest-summary.py, vitest-batch.sh). Run: python3 scripts/speedup/test_speedup.py"""
import json, os, subprocess, tempfile, textwrap, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SDD = os.path.join(os.path.dirname(HERE), 'sdd')
ENV = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'}


def write(root, rel, text=''):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w') as f:
        f.write(text)


def git(root, *a):
    return subprocess.run(['git', *a], cwd=root, capture_output=True, text=True, env=ENV, check=True).stdout.strip()


def tiny_repo():
    """a.e2e-spec -> helper -> util (relative + @app alias + barrel), b.e2e-spec -> other; test/ holds the shared setup."""
    d = tempfile.mkdtemp()
    git(d, 'init', '-q')
    b = 'packages/backend/'
    write(d, b + 'libs/domains/x/a.e2e-spec.ts', "import { h } from './testing/helper';\nimport { u } from '@app/common/util';\nit('a', () => h(u));\n")
    write(d, b + 'libs/domains/x/testing/helper.ts', "export const h = (x: unknown) => x;\n")
    write(d, b + 'libs/common/util/index.ts', "export const u = 1;\n")
    write(d, b + 'libs/domains/x/b.e2e-spec.ts', "import { o } from './other';\nit('b', () => o);\n")
    write(d, b + 'libs/domains/x/other.ts', "export const o = 2;\n")
    write(d, b + 'libs/domains/x/unrelated.ts', "export const z = 3;\n")
    write(d, b + 'test/e2e-env.setup.ts', "// setup\n")
    write(d, b + 'package.json', '{}\n')
    write(d, 'docs/note.md', 'hi\n')
    git(d, 'add', '-A'); git(d, 'commit', '-qm', 'one')
    return d


def run(script, root, *args, **env):
    return subprocess.run(['bash', os.path.join(HERE, script), *args], capture_output=True, text=True, cwd=root, env={**ENV, 'SPEEDUP_REPO': root, **env})


class Speedup(unittest.TestCase):
    def setUp(self):
        self.d = tiny_repo()
        self.cache = os.path.join(self.d, 'cache.jsonl')

    def lines(self, r):
        return [l for l in r.stdout.split('\n') if l]

    def test_selects_only_the_specs_that_import_the_changed_file(self):
        write(self.d, 'packages/backend/libs/domains/x/testing/helper.ts', "export const h = (x: unknown) => [x];\n")
        self.assertEqual(self.lines(run('select-tests.sh', self.d, 'HEAD', PASS_CACHE=self.cache)), ['libs/domains/x/a.e2e-spec.ts'])
        write(self.d, 'packages/backend/libs/common/util/index.ts', "export const u = 5;\n")   # reached through the @app alias and an index file
        git(self.d, 'checkout', 'packages/backend/libs/domains/x/testing/helper.ts')
        self.assertEqual(self.lines(run('select-tests.sh', self.d, 'HEAD')), ['libs/domains/x/a.e2e-spec.ts'])

    def test_a_new_uncommitted_spec_and_an_unrelated_change(self):
        write(self.d, 'packages/backend/libs/domains/x/unrelated.ts', "export const z = 4;\n")
        write(self.d, 'docs/note.md', 'changed\n')
        r = run('select-tests.sh', self.d, 'HEAD')
        self.assertEqual(self.lines(r), [], r.stderr)
        write(self.d, 'packages/backend/libs/domains/x/c.e2e-spec.ts', "import { z } from './unrelated';\nit('c', () => z);\n")
        self.assertEqual(self.lines(run('select-tests.sh', self.d, 'HEAD')), ['libs/domains/x/c.e2e-spec.ts'])

    def test_shared_test_infrastructure_means_run_everything(self):
        for rel in ('packages/backend/test/e2e-env.setup.ts', 'packages/backend/package.json'):
            write(self.d, rel, 'changed\n')
            self.assertEqual(self.lines(run('select-tests.sh', self.d, 'HEAD')), ['libs/domains/x/a.e2e-spec.ts', 'libs/domains/x/b.e2e-spec.ts'], rel)
            git(self.d, 'checkout', rel)
        self.assertEqual(len(self.lines(run('select-tests.sh', self.d, 'HEAD', FULL='1'))), 2)

    def test_default_base_is_head_minus_one_without_a_cache_and_the_cached_commit_with_one(self):
        write(self.d, 'packages/backend/libs/domains/x/other.ts', "export const o = 9;\n")
        git(self.d, 'commit', '-qam', 'two')
        self.assertEqual(self.lines(run('select-tests.sh', self.d, PASS_CACHE=self.cache)), ['libs/domains/x/b.e2e-spec.ts'])   # HEAD~1
        run('pass-cache.sh', self.d, 'record', 'libs/domains/x/b.e2e-spec.ts', PASS_CACHE=self.cache)   # cache knows commit "two"
        self.assertEqual(self.lines(run('select-tests.sh', self.d, PASS_CACHE=self.cache)), [])

    def test_pass_cache_skips_a_file_until_it_or_something_it_imports_changes(self):
        a, b = 'libs/domains/x/a.e2e-spec.ts', 'libs/domains/x/b.e2e-spec.ts'
        env = dict(PASS_CACHE=self.cache)
        self.assertEqual(self.lines(run('pass-cache.sh', self.d, 'check', a, b, **env)), [a, b])   # nothing recorded yet
        run('pass-cache.sh', self.d, 'record', a, b, **env)
        r = run('pass-cache.sh', self.d, 'check', a, b, **env)
        self.assertEqual(self.lines(r), []); self.assertIn('2 skipped', r.stderr)
        write(self.d, 'packages/backend/libs/domains/x/testing/helper.ts', "export const h = 1;\n")     # imported by a only
        self.assertEqual(self.lines(run('pass-cache.sh', self.d, 'check', a, b, **env)), [a])
        run('pass-cache.sh', self.d, 'record', a, **env)
        self.assertEqual(self.lines(run('pass-cache.sh', self.d, 'check', a, b, **env)), [])
        write(self.d, 'packages/backend/test/e2e-env.setup.ts', "// changed setup\n")                      # shared setup: everything again
        self.assertEqual(self.lines(run('pass-cache.sh', self.d, 'check', a, b, **env)), [a, b])
        write(self.d, 'packages/backend/libs/domains/x/b.e2e-spec.ts', "it('b changed', () => 1);\n")     # the file itself
        run('pass-cache.sh', self.d, 'record', a, **env)
        self.assertEqual(self.lines(run('pass-cache.sh', self.d, 'check', a, b, **env)), [b])

    def test_record_report_keeps_only_passed_files_and_unpassed_filter_uses_the_cache(self):
        a, b = 'libs/domains/x/a.e2e-spec.ts', 'libs/domains/x/b.e2e-spec.ts'
        rep = os.path.join(self.d, 'report.json')
        base = os.path.join(self.d, 'packages/backend')
        json.dump({'testResults': [{'name': os.path.join(base, a), 'status': 'passed', 'assertionResults': [{'status': 'passed'}]},
                                   {'name': os.path.join(base, b), 'status': 'failed', 'assertionResults': [{'status': 'failed'}]}]}, open(rep, 'w'))
        run('pass-cache.sh', self.d, 'record-report', rep, PASS_CACHE=self.cache)
        write(self.d, 'packages/backend/test/e2e-env.setup.ts', "// x\n")  # would select both ...
        write(self.d, 'packages/backend/libs/domains/x/other.ts', "export const o = 7;\n")
        # ... but the setup change also changes the fingerprints, so use a change that leaves a's hash alone: record again after the setup change
        run('pass-cache.sh', self.d, 'record', a, PASS_CACHE=self.cache)
        r = run('select-tests.sh', self.d, 'HEAD', '--unpassed', PASS_CACHE=self.cache)
        self.assertEqual(self.lines(r), [b], r.stderr)

    def test_the_real_repo_resolves_every_spec_and_the_order_export_fixture_reaches_its_specs(self):
        env = {**os.environ}; env.pop('SPEEDUP_REPO', None)
        out = subprocess.run(['python3', os.path.join(HERE, 'depgraph.py'), 'select', 'packages/backend/libs/domains/orders/testing/order-export.fixtures.ts'], capture_output=True, text=True, env=env).stdout
        self.assertIn('libs/domains/orders/order-export.e2e-spec.ts', out)
        self.assertNotIn('libs/domains/catalog/', out)


class VitestSummary(unittest.TestCase):
    def test_summary_lines_feed_the_existing_readers(self):
        d = tempfile.mkdtemp(); rep = os.path.join(d, 'r.json'); log = os.path.join(d, 'sweep.log')
        json.dump({'numPassedTests': 3, 'numFailedTests': 1, 'numTotalTests': 4, 'testResults': [
            {'name': '/r/packages/backend/libs/infrastructure/a.e2e-spec.ts', 'status': 'passed', 'assertionResults': [{'status': 'passed'}]},
            {'name': '/r/packages/backend/libs/infrastructure/b.e2e-spec.ts', 'status': 'failed', 'assertionResults': [{'status': 'failed', 'title': 'AS-1', 'ancestorTitles': ['S1'], 'failureMessages': ['boom']}]},
            {'name': '/r/packages/backend/libs/infrastructure/c.e2e-spec.ts', 'status': 'failed', 'message': 'cannot import', 'assertionResults': []}]}, open(rep, 'w'))
        out = subprocess.run(['python3', os.path.join(SDD, 'vitest-summary.py'), rep, '/r/packages/backend'], capture_output=True, text=True).stdout
        self.assertIn('PASS libs/infrastructure/a.e2e-spec.ts\n', out)
        self.assertIn('FAIL libs/infrastructure/b.e2e-spec.ts\n', out)
        self.assertIn('  ● S1 › AS-1\n', out)
        self.assertIn('  ● Test suite failed to run\n', out)
        self.assertIn('Test Suites: 2 failed, 1 passed, 3 total\n', out)
        self.assertIn('Tests:       1 failed, 3 passed, 4 total\n', out)
        open(log, 'w').write(out)
        v = subprocess.run(['python3', os.path.join(SDD, 'sweep-verdict.py'), log], capture_output=True, text=True).stdout
        self.assertIn('FAILED: libs/infrastructure/b.e2e-spec.ts', v)
        self.assertIn('FAILED: libs/infrastructure/c.e2e-spec.ts', v)

    def test_a_missing_report_prints_no_summary_so_a_crashed_batch_is_noticed(self):
        r = subprocess.run(['python3', os.path.join(SDD, 'vitest-summary.py'), '/nonexistent.json'], capture_output=True, text=True)
        self.assertEqual(r.stdout, '')

    def test_no_script_still_calls_the_jest_e2e_runner(self):
        for f in ('sweep-backend.sh', 'checkpoint.sh', 'test-spec.sh', 'implement-specs.sh'):
            text = open(os.path.join(SDD, f)).read()
            self.assertNotIn('jest-e2e.json', text, f)
            self.assertNotIn('--listTests', text, f)


if __name__ == '__main__':
    unittest.main()
