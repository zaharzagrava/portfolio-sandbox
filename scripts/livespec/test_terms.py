#!/usr/bin/env python3
"""terms.py with a fake model: phrases are linked once, a new term's own definition is read in turn (depth is not fixed), the loop ends when nothing new is found."""
import json, os, shutil, sys, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


class TermsTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        os.environ['LIVESPEC_ROOT'] = self.d
        for m in [m for m in sys.modules if m in ('common', 'terms')]: del sys.modules[m]
        import common, terms
        self.common, self.terms = common, terms
        os.makedirs(os.path.join(self.d, 'docs/spec/concepts'))
        self.page = os.path.join(self.d, 'docs/spec/concepts/x.md')
        open(self.page, 'w').write("---\nid: x\ntitle: X\nkind: concept\nstatus: draft\ndefined_by: S1\n---\n# X\n## Rules\n- **x.C-01** Each section MUST carry one entry.\n- **x.C-02** Nothing special here.\n")

    def test_recursion_links_and_stops(self):
        calls = []
        def fake(prompt, model=None):
            calls.append(prompt)
            if prompt.startswith('Write the explanation page of each term'):
                import re as _re
                slugs = _re.findall(r'^TERM ([a-z0-9-]+):', prompt, _re.M)
                return '\n'.join(f"=== {sl}\n## Definition\n" + ("A section is a named part. It has an entry." if sl == 'section' else "An entry is a line.") + "\n\n## Example\nx\n" for sl in slugs)
            if '### x.C-01' in prompt:
                return json.dumps({'x.C-01': [{'phrase': 'section', 'slug': 'section', 'title': 'Section', 'aliases': []}, {'phrase': 'entry', 'slug': 'entry', 'title': 'Entry', 'aliases': []}], 'x.C-02': []})
            if '### section' in prompt:   # the definition of "section" leans on "entry": already a term by now, so it is only linked
                return json.dumps({'section': [{'phrase': 'entry', 'slug': 'entry', 'title': 'Entry', 'aliases': []}]})
            return json.dumps({k: [] for k in ('entry',)})
        self.terms.MODEL_FN = fake
        self.terms.expand(self.page)
        text = open(self.page).read()
        self.assertIn('[section](../terms/section.md)', text)
        self.assertIn('[entry](../terms/entry.md)', text)
        self.assertIn('Nothing special here.', text)   # untouched
        sec = open(os.path.join(self.d, 'docs/spec/terms/section.md')).read()
        self.assertIn('[entry](entry.md)', sec)         # layer 2 links to layer 1
        self.assertTrue(os.path.exists(os.path.join(self.d, 'docs/spec/terms/entry.md')))

    def test_phrase_not_in_text_is_dropped(self):
        self.terms.MODEL_FN = lambda p, m=None: json.dumps({'x.C-01': [{'phrase': 'does not occur', 'slug': 'z', 'title': 'Z', 'aliases': []}]})
        self.terms.expand(self.page)
        self.assertFalse(os.path.exists(os.path.join(self.d, 'docs/spec/terms/z.md')))

    def test_general_concept_links_to_a_checked_reference_and_gets_no_page(self):
        open(self.page, 'a').write("- **x.C-03** The cookie MUST be HttpOnly and sent to evil.\n")
        def fake(prompt, model=None):
            return json.dumps({'x.C-03': [
                {'phrase': 'HttpOnly', 'kind': 'external', 'slug': 'httponly', 'title': 'HttpOnly', 'aliases': [], 'url': 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Cookies', 'source': 'MDN'},
                {'phrase': 'evil', 'kind': 'external', 'slug': 'evil', 'title': 'Evil', 'aliases': [], 'url': 'https://evil.example/x', 'source': 'x'}]})
        self.terms.MODEL_FN = fake
        self.terms.FETCH_FN = lambda url: (200, 'The HttpOnly attribute ...')
        self.terms.expand(self.page, only={'C-03'})
        text = open(self.page).read()
        self.assertIn('[HttpOnly ↗](../sw-external-terms.md#httponly)', text)
        self.assertIn('developer.mozilla.org/en-US/docs/Web/HTTP/Cookies', open(os.path.join(self.d, 'docs/spec/sw-external-terms.md')).read())
        self.assertNotIn('evil.example', text)                                   # host not on the allow-list: no link
        self.assertFalse(os.path.exists(os.path.join(self.d, 'docs/spec/terms/httponly.md')))
        self.assertIn('httponly\tHttpOnly\thttps://developer.mozilla.org', open(os.path.join(self.d, 'docs/spec/terms/external.tsv')).read())

    def test_rules_hash_changes_when_a_linking_rule_changes_and_numbers_are_found(self):
        os.makedirs(os.path.join(self.d, 'docs/spec/terms'))
        open(os.path.join(self.d, 'docs/spec/terms/section.md'), 'w').write('---\nid: section\ntitle: Section\nkind: term\nstatus: draft\n---\n# Section\n## Definition\nx\n')
        open(self.page, 'a').write('- **x.C-03** Each [section](../terms/section.md) has 5 retries.\n')
        pages = lambda: self.common.pages('concept')   # noqa: E731
        h1 = self.common.term_rules_hash('section', pages())
        self.assertEqual(h1, self.common.term_rules_hash('section', pages()))
        open(self.page, 'w').write(open(self.page).read().replace('5 retries', '6 retries'))
        self.assertNotEqual(h1, self.common.term_rules_hash('section', pages()))
        self.assertEqual(self.common.numbers_in('after 5 failures within 10 s, 1,000 ms, up to 2'), {'5', '10', '1000'})

    def test_cycles_are_found_and_reachability_works(self):
        c = self.common
        g = {'a': {'b'}, 'b': {'c'}, 'c': {'a'}, 'd': {'a'}, 'e': set()}
        self.assertEqual(c.find_cycles(g), [['a', 'b', 'c']])
        self.assertEqual(c.find_cycles({'a': {'b'}, 'b': set()}), [])
        self.assertTrue(c.reaches(g, 'd', 'c'))
        self.assertFalse(c.reaches(g, 'e', 'a'))

    def test_second_place_promotes_an_inline_concept_to_a_shared_page(self):
        t = self.terms
        second = os.path.join(self.d, 'docs/spec/concepts/y.md')
        open(second, 'w').write("---\nid: y\ntitle: Y\nkind: concept\nstatus: draft\ndefined_by: S1\n---\n# Y\n## Rules\n- **y.C-01** A hold (a promise of stock) lasts 5 minutes.\n")
        open(self.page, 'a').write("- **x.C-03** A hold (a reserved amount) is released on cancel.\n")
        t.MODEL_FN = lambda prompt, model=None: "=== hold\n## Definition\nA hold keeps something for a buyer.\n\n## Example\nx\n"
        t.record_inline(self.page, [{'key': 'x.C-03', 'phrase': 'hold', 'span': 'a reserved amount', 'slug': 'hold', 'title': 'Hold'}], True)
        self.assertEqual(t.promote(None), [])            # one place only: no page yet
        self.assertFalse(os.path.exists(os.path.join(self.d, 'docs/spec/terms/hold.md')))
        t.record_inline(second, [{'key': 'y.C-01', 'phrase': 'hold', 'span': 'a promise of stock', 'slug': 'hold', 'title': 'Hold'}], True)
        self.assertEqual(t.promote(None), ['hold'])      # a second place: one shared page, both places link it
        self.assertIn('[hold](../terms/hold.md)', open(self.page).read())
        self.assertIn('[hold](../terms/hold.md)', open(second).read())
        self.assertTrue(all(r['status'] == 'promoted' for r in t.load_inline()))

    def test_link_first_skips_existing_links(self):
        import terms
        t, ok = terms.link_first('see [section](a.md) and section', 'section', 'b.md')
        self.assertTrue(ok); self.assertEqual(t, 'see [section](a.md) and [section](b.md)')


if __name__ == '__main__': unittest.main()
