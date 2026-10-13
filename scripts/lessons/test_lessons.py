#!/usr/bin/env python3
"""Tests for the lessons loop: python3 scripts/lessons/test_lessons.py (a throwaway project is the fixture)."""
import contextlib
import io
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import check  # noqa: E402
import common  # noqa: E402
import digest  # noqa: E402

LESSONS = """# Lessons

- L-001 2026-10-01 wiring prevented
- L-002 2026-10-02 config open
- L-003 2026-10-20 wiring prevented
- L-004 2026-10-21 timing open

## L-001 A queue option the queue refuses
- **Rule:** Validate queue options when the task is created.
- **Symptom:** stuck. **Cause:** `groupId` on a standard queue.
- **Prevention:** the outbox validates (`libs/outbox/append.ts`, `append.spec.ts`). Evidence: `docs/incident.md`.

## L-002 A queue missing from the config
- **Rule:** Every queue the code names is defined in the config.
- **Symptom:** nothing happens. **Prevention missing:** a doctor check.

## L-003 Same class again
- **Rule:** Check the wiring first.
- **Symptom:** x. **Prevention:** a test in `libs/outbox/other.spec.ts`.

## L-004 Slow machine
- **Symptom:** y. **Prevention missing:** longer timeouts. They are needed. Then more text.
"""


def make_project(root, lessons=LESSONS):
    for rel in ('libs/outbox/append.ts', 'libs/outbox/append.spec.ts', 'libs/outbox/other.spec.ts', 'docs/incident.md'):
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w') as f:
            f.write('x')
    os.makedirs(os.path.join(root, 'docs'), exist_ok=True)
    with open(os.path.join(root, 'docs', 'lessons.md'), 'w') as f:
        f.write(lessons)


def run(mod, args):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = mod.main(args)
    return rc, out.getvalue(), err.getvalue()


class ParseTests(unittest.TestCase):
    def test_parse_index_and_entries(self):
        lessons, problems = common.parse(LESSONS)
        self.assertEqual(problems, [])
        self.assertEqual([x.id for x in lessons], ['L-001', 'L-002', 'L-003', 'L-004'])
        self.assertEqual(lessons[0].rule, 'Validate queue options when the task is created.')
        self.assertEqual(lessons[3].rule, 'longer timeouts')  # no Rule line: first sentence of the prevention text

    def test_structure_problems(self):
        _, problems = common.parse('- L-001 2026-10-01 wiring prevented\n- L-001 2026-10-01 wiring prevented\n## L-009 x\n')
        self.assertTrue(any('twice' in p for p in problems))
        self.assertTrue(any('L-009' in p and 'not in the index' in p for p in problems))
        self.assertTrue(any('L-001' in p and 'no "## L-001" entry' in p for p in problems))

    def test_repeats_are_the_second_and_later_lesson_of_a_class(self):
        lessons, _ = common.parse(LESSONS)
        self.assertEqual(common.repeats(lessons), {'wiring': ['L-003']})


class CheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        make_project(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_clean_project_passes_and_reports_old_open_lessons_and_repeats(self):
        rc, out, _ = run(check, ['--root', self.root, '--today', '2026-10-25'])
        self.assertEqual(rc, 0, out)
        self.assertIn('open for more than 14 days', out)
        self.assertIn('L-002 (config, 23 days)', out)
        self.assertNotIn('L-004 (timing', out)  # 4 days old
        self.assertIn('wiring: 1 (L-003)', out)
        self.assertNotIn('BROKEN', out)

    def test_deleting_a_linked_prevention_fails_the_check(self):
        os.remove(os.path.join(self.root, 'libs/outbox/append.spec.ts'))  # linked by bare name from L-001
        rc, out, _ = run(check, ['--root', self.root, '--today', '2026-10-25'])
        self.assertEqual(rc, 1)
        self.assertIn('BROKEN: L-001: the prevention `append.spec.ts` does not exist', out)

    def test_deleting_a_linked_path_fails_the_check(self):
        os.remove(os.path.join(self.root, 'libs/outbox/other.spec.ts'))
        rc, out, _ = run(check, ['--root', self.root, '--today', '2026-10-25'])
        self.assertEqual(rc, 1)
        self.assertIn('L-003: the prevention `libs/outbox/other.spec.ts` does not exist', out)

    def test_prevented_without_any_link_fails(self):
        make_project(self.root, LESSONS.replace('- **Symptom:** x. **Prevention:** a test in `libs/outbox/other.spec.ts`.',
                                                '- **Symptom:** x. **Prevention:** we promise to be careful.'))
        rc, out, _ = run(check, ['--root', self.root, '--today', '2026-10-25'])
        self.assertEqual(rc, 1)
        self.assertIn('L-003 is "prevented" but links no prevention', out)

    def test_open_lessons_need_no_links(self):
        rc, out, _ = run(check, ['--root', self.root, '--today', '2026-10-25'])
        self.assertEqual(rc, 0, out)

    def test_commit_links_are_checked_with_git(self):
        git = lambda *a: subprocess.run(['git', '-C', self.root, '-c', 'user.email=a@b', '-c', 'user.name=t', *a], capture_output=True, text=True, check=True)
        git('init', '-q')
        git('add', '-A')
        git('commit', '-q', '-m', 'x')
        sha = git('rev-parse', '--short=8', 'HEAD').stdout.strip()
        text = LESSONS.replace('Evidence: `docs/incident.md`.', f'Evidence: `docs/incident.md`, `{sha}`.')
        make_project(self.root, text)
        rc, out, _ = run(check, ['--root', self.root, '--today', '2026-10-25'])
        self.assertEqual(rc, 0, out)
        make_project(self.root, text.replace(sha, 'abcdef1' if not sha.startswith('abcdef1') else '1234567'))
        rc, out, _ = run(check, ['--root', self.root, '--today', '2026-10-25'])
        self.assertEqual(rc, 1)
        self.assertIn('does not exist', out)

    def test_real_repository_lessons_pass(self):
        rc, out, _ = run(check, [])
        self.assertEqual(rc, 0, out)


class DigestTests(unittest.TestCase):
    def test_digest_lists_classes_and_rules(self):
        lessons, _ = common.parse(LESSONS)
        text = '\n'.join(digest.build(lessons))
        self.assertIn('wiring (2 lessons, 1 repeat):', text)
        self.assertIn('- L-001 Validate queue options when the task is created.', text)
        self.assertIn('[open: no check yet]', text)

    def test_digest_never_exceeds_the_line_limit(self):
        many = ''.join(f'- L-{i:03d} 2026-10-{1 + i % 28:02d} {digest.common.CLASSES[i % 7]} prevented\n' for i in range(1, 80))
        many += ''.join(f'## L-{i:03d} t\n- **Rule:** rule number {i} ' + 'long ' * 60 + '\n' for i in range(1, 80))
        lessons, _ = common.parse(many)
        out = digest.build(lessons)
        self.assertLessEqual(len(out), 40)
        self.assertTrue(all(len(line) <= digest.MAX_LINE + 20 for line in out))
        self.assertIn('older in docs/lessons.md', '\n'.join(out))

    def test_real_repository_digest_fits(self):
        rc, out, _ = run(digest, [])
        self.assertEqual(rc, 0)
        self.assertLessEqual(len(out.rstrip('\n').split('\n')), 40)
        self.assertIn('Known failure classes', out)

    def test_missing_file_prints_nothing(self):
        rc, out, _ = run(digest, ['/nonexistent/lessons.md'])
        self.assertEqual((rc, out), (0, ''))


class PromptWiringTests(unittest.TestCase):
    ROOT = common.ROOT

    def test_lessons_block_is_a_short_prompt_block(self):
        r = subprocess.run(['bash', '-c', f'ROOT={self.ROOT}; source {self.ROOT}/scripts/sdd/lib.sh; lessons_block'], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        lines = r.stdout.rstrip('\n').split('\n')
        self.assertIn('Known failure classes', lines[0])
        self.assertEqual(sum('Known failure classes' in x for x in lines), 1)
        self.assertLessEqual(len(lines), 41)

    def test_builder_spec_and_repair_prompts_carry_the_digest(self):
        src = open(os.path.join(self.ROOT, 'scripts', 'sdd', 'implement-specs.sh')).read()
        self.assertIn('LESSONS="$(lessons_block)"', src)
        # extra_context() is part of every plan, tasks, analyze, implement, converge and gate-repair prompt; doctor_prompt() is the repair agent's
        for fn in ('extra_context()', 'doctor_prompt()'):
            body = src[src.index(fn):]
            body = body[:body.index('\n}\n')]
            self.assertIn('$LESSONS', body, fn)
        self.assertEqual(subprocess.run(['bash', '-n', os.path.join(self.ROOT, 'scripts', 'sdd', 'implement-specs.sh')]).returncode, 0)


if __name__ == '__main__':
    unittest.main()
