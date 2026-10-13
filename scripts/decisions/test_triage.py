import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import triage

GOOD = """---
id: S99
title: Decisions for X
generated: 2026-10-13
---
# Decisions needing your call: S99 X
One sentence.

- **S99.D-01** Question one?
  - default: a
  - status: open

- **S99.D-02** Question two?
  - default: b
  - status: change: use 10 instead
"""


class Triage(unittest.TestCase):
    def test_parse_statuses(self):
        items = triage.parse(GOOD)
        self.assertEqual([i['status'] for i in items], ['open', 'change'])
        self.assertEqual(triage.check_text(GOOD, 'S99'), [])

    def test_missing_status_and_foreign_id_are_reported(self):
        bad = GOOD.replace('  - status: open\n', '').replace('S99.D-02', 'S10.D-02')
        problems = ' '.join(triage.check_text(bad, 'S99'))
        self.assertIn('no `- status:` line', problems)
        self.assertIn('does not belong', problems)

    def test_too_many_decisions(self):
        many = GOOD + ''.join(f'\n- **S99.D-{n}** q\n  - status: open\n' for n in range(10, 30))
        self.assertTrue(any('more than' in p for p in triage.check_text(many, 'S99')))


if __name__ == '__main__':
    unittest.main()
