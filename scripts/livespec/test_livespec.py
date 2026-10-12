#!/usr/bin/env python3
"""Tests for the living-spec verification scripts: python3 scripts/livespec/test_livespec.py (a throwaway project is the fixture)."""
import importlib
import io
import contextlib
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

CAP = """---
id: S99
title: Demo capability
kind: capability
status: draft
depends_on: []
concepts: [idem]
models: [demo-status]
scope: [packages/backend/demo/**]
---
# S99 - Demo
## Purpose
Demo.
## Rules
- **S99.R-01** One payment per order. [proof: S99 AS-01] [code: packages/backend/demo/service.ts#Service]
- **S99.R-02** Money is never negative. [proof: none]
## Behaviors
- **S99.B-01** Given an order, when it is paid, then it is marked paid. [proof: S99 AS-01]
  It continues on a second line.
## Known gaps
none
"""
CONCEPT = """---
id: idem
title: Idempotency
kind: concept
status: draft
defined_by: S99
---
# Idempotency
## Definition
Same request, same effect. {{cap:S99}}
<!-- used-by:start -->
- {{cap:S99}} Demo capability
<!-- used-by:end -->
"""
MODEL = """---
id: demo-status
title: Demo status
kind: model
status: draft
code: packages/backend/demo/service.ts
---
# Demo status
```statemachine
initial: NEW
terminal: DONE
states: NEW, PAID, DONE
events: pay, finish
ignore: NEW.finish, PAID.pay
NEW --pay--> PAID
PAID --finish--> DONE
```
"""


def write(root, rel, text):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w').write(text)


def load(root):
    os.environ['LIVESPEC_ROOT'] = root
    for name in ('common', 'models', 'sign', 'check'):
        sys.modules.pop(name, None)
    return {n: importlib.import_module(n) for n in ('common', 'models', 'sign', 'check')}


def run_check(mods, *args):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        rc = mods['check'].main(list(args))
    return rc, out.getvalue()


class LiveSpec(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        write(self.root, 'scripts/sdd/capabilities.tsv', 'S99\tdemo\tdemo\tDemo capability\tsrc\n')
        write(self.root, 'packages/backend/demo/service.ts', 'export class Service { }\nenum Status { NEW, PAID, DONE }\n')
        write(self.root, 'packages/backend/demo/service.e2e-spec.ts', "it('S99 AS-01: one payment per order', () => {});\n")
        write(self.root, 'docs/spec/capabilities/S99-demo.md', CAP)
        write(self.root, 'docs/spec/concepts/idem.md', CONCEPT)
        write(self.root, 'docs/spec/models/demo-status.md', MODEL)
        for a in (['init', '-q'], ['config', 'user.email', 't@t'], ['config', 'user.name', 'T'], ['add', '-A'], ['commit', '-qm', 'i']):
            subprocess.run(['git', '-C', self.root, *a], check=True, capture_output=True)
        self.m = load(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def edit(self, rel, old, new):
        p = os.path.join(self.root, rel)
        t = open(p).read()
        assert old in t, old
        open(p, 'w').write(t.replace(old, new))
        self.m = load(self.root)

    # --- parsing
    def test_items_front_matter_and_continuation(self):
        page = self.m['common'].load_page(os.path.join(self.root, 'docs/spec/capabilities/S99-demo.md'))
        self.assertEqual(page['front']['id'], 'S99')
        self.assertEqual(page['front']['depends_on'], [])
        self.assertEqual(page['front']['scope'], ['packages/backend/demo/**'])
        self.assertEqual([i['id'] for i in page['items']], ['S99.R-01', 'S99.R-02', 'S99.B-01'])
        self.assertIn('second line', page['items'][2]['text'])

    # --- check.py
    def test_a_good_graph_passes_and_counts_proofs(self):
        rc, out = run_check(self.m)
        self.assertEqual(rc, 0, out)
        self.assertIn('2 with a proof, 1 marked `[proof: none]`', out)
        self.assertEqual(run_check(self.m, '--strict')[0], 1)   # the unproven rule is a warning; strict makes it fail

    def test_a_proof_that_names_no_test_is_an_error(self):
        self.edit('docs/spec/capabilities/S99-demo.md', '[proof: S99 AS-01] [code', '[proof: S99 AS-77] [code')
        rc, out = run_check(self.m)
        self.assertEqual(rc, 1)
        self.assertIn('no test title carries that id', out)

    def test_a_rule_without_a_proof_clause_is_an_error(self):
        self.edit('docs/spec/capabilities/S99-demo.md', 'Money is never negative. [proof: none]', 'Money is never negative.')
        self.assertIn('needs `[proof: ...]`', run_check(self.m)[1])

    def test_code_refs_must_exist(self):
        self.edit('docs/spec/capabilities/S99-demo.md', '#Service]', '#Gone]')
        self.assertIn('symbol Gone not found', run_check(self.m)[1])
        self.edit('docs/spec/capabilities/S99-demo.md', 'demo/service.ts#Gone', 'demo/nothere.ts#Gone')
        self.assertIn('file not found', run_check(self.m)[1])

    def test_broken_links_and_scope(self):
        self.edit('docs/spec/capabilities/S99-demo.md', 'Demo.\n## Rules', 'Demo. {{concept:nope}} {{cap:S11}}\n## Rules')
        out = run_check(self.m)[1]
        self.assertIn('concept:nope', out)
        self.assertIn('cap:S11', out)
        self.edit('docs/spec/capabilities/S99-demo.md', 'demo/**]', 'gone/**]')
        self.assertIn('matches no file', run_check(self.m)[1])

    def test_item_ids_must_belong_to_the_page(self):
        self.edit('docs/spec/capabilities/S99-demo.md', '**S99.R-02**', '**S11.R-02**')
        self.assertIn('must start with "S99."', run_check(self.m)[1])

    def test_stale_backlinks_are_reported_and_fixed(self):
        self.edit('docs/spec/concepts/idem.md', '- {{cap:S99}} Demo capability', '_nobody yet_')
        self.assertIn('stale', run_check(self.m)[1])
        run_check(self.m, '--fix-backlinks')
        self.m = load(self.root)
        self.assertNotIn('stale', run_check(self.m)[1])

    def test_code_changed_but_the_page_did_not(self):
        base = subprocess.run(['git', '-C', self.root, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
        write(self.root, 'packages/backend/demo/service.ts', 'export class Service { x = 1 }\nenum Status { NEW, PAID, DONE }\n')
        out = run_check(self.m, '--base', base)[1]
        self.assertIn('did not; edit the page first', out)

    def test_style_warns_about_vague_words_and_long_sentences(self):
        self.edit('docs/spec/capabilities/S99-demo.md', 'One payment per order.', 'It should handle payments appropriately.')
        out = run_check(self.m)[1]
        self.assertIn('vague word(s)', out)
        self.assertIn('should', out)
        long = ' '.join(['word'] * 35) + '.'
        self.edit('docs/spec/capabilities/S99-demo.md', 'It should handle payments appropriately.', long)
        self.assertIn('a sentence of 35 words', run_check(self.m)[1])

    def test_route_claims_must_exist_in_a_controller(self):
        write(self.root, 'packages/backend/libs/x.controller.ts', "@Controller('demo')\nclass C { @Get(':id') one() {} @Post() make() {} }\n")
        write(self.root, 'packages/backend/libs/y.controller.ts', "@Controller()\nclass D { @Post('payments/intents') pay() {} }\n")
        self.edit('docs/spec/capabilities/S99-demo.md', '## Rules', '## Entry points\n- `GET /api/demo/:demoId` one. `POST /demo` make. `POST /payments/intents` pay.\n## Rules')
        self.assertNotIn('no controller defines', run_check(self.m)[1])
        self.edit('docs/spec/capabilities/S99-demo.md', '`POST /demo`', '`POST /demo/refund`')
        self.assertIn('route `POST /demo/refund`', run_check(self.m)[1])

    # --- models.py
    def machine(self, body):
        return self.m['models'].parse_machine('```statemachine\n' + body + '\n```')

    def problems(self, body):
        return [m for sev, m in self.m['models'].check_machine(self.machine(body)) if sev == 'error']

    def test_a_total_machine_is_clean(self):
        page = self.m['common'].load_page(os.path.join(self.root, 'docs/spec/models/demo-status.md'))
        self.assertEqual([m for s, m in self.m['models'].check_machine(self.m['models'].parse_machine(page['body']), page['front']) if s == 'error'], [])

    def test_machine_problems_are_named(self):
        base = 'initial: A\nterminal: C\nstates: A, B, C\nevents: go\n'
        self.assertTrue(any('not total' in m for m in self.problems(base + 'A --go--> B')))                      # B.go undefined
        self.assertTrue(any('not reachable' in m for m in self.problems(base + 'A --go--> C\nB --go--> C')))    # B unreachable
        self.assertTrue(any('not deterministic' in m for m in self.problems(base + 'A --go--> B\nA --go--> C\nB --go--> C')))
        self.assertTrue(any('terminal state C has an outgoing' in m for m in self.problems(base + 'A --go--> C\nB --go--> C\nC --go--> A')))
        self.assertTrue(any('undeclared' in m or 'not declared' in m for m in self.problems(base + 'A --go--> Z')))

    def test_refused_and_idempotent_pairs_answer_the_question(self):
        base = 'initial: A\nterminal: C\nstates: A, B, C\nevents: go, again\nA --go--> B\nB --go--> C\n'
        self.assertTrue(any('not total' in m for m in self.problems(base)))
        self.assertEqual([m for m in self.problems(base + 'refused: A.again\nidempotent: B.again')], [])
        self.assertTrue(any('also has a transition' in m for m in self.problems(base + 'refused: A.go, A.again\nidempotent: B.again')))

    def test_machine_states_must_appear_in_the_code(self):
        page = self.m['common'].load_page(os.path.join(self.root, 'docs/spec/models/demo-status.md'))
        mc = self.m['models'].parse_machine(page['body'])
        mc['states'].append('GHOST')
        self.assertTrue(any('GHOST does not appear' in m for _, m in self.m['models'].check_machine(mc, page['front'])))

    # --- sign.py
    def test_sign_then_drift(self):
        rc = self.m['sign'].cmd_sign('S99', 'Me', None)
        self.assertEqual(rc, 0)
        self.m = load(self.root)
        self.assertEqual(run_check(self.m)[0], 0)
        self.assertIn('status: reviewed', open(os.path.join(self.root, 'docs/spec/capabilities/S99-demo.md')).read())
        self.edit('docs/spec/capabilities/S99-demo.md', 'One payment per order.', 'Two payments per order.')
        rc, out = run_check(self.m)
        self.assertEqual(rc, 1)
        self.assertIn('signed items changed since review: S99.R-01', out)

    def test_whitespace_changes_are_not_drift(self):
        self.m['sign'].cmd_sign('S99', 'Me', None)
        self.edit('docs/spec/capabilities/S99-demo.md', 'One payment per order.', 'One   payment\n  per order.')
        self.assertEqual(run_check(self.m)[0], 0)

    def test_guard_fails_for_a_changed_signoff(self):
        self.m['sign'].cmd_sign('S99', 'Me', None)
        self.assertEqual(run_check(self.m, '--guard')[0], 1)
        for a in (['add', '-A'], ['commit', '-qm', 'signed']):
            subprocess.run(['git', '-C', self.root, *a], check=True, capture_output=True)
        self.assertEqual(run_check(self.m, '--guard')[0], 0)


if __name__ == '__main__':
    unittest.main(verbosity=1)
