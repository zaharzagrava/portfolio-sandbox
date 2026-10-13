import os, sys, tempfile, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mutate


class Mutate(unittest.TestCase):
    def write(self, text):
        f = tempfile.NamedTemporaryFile('w', suffix='.ts', delete=False)
        f.write(text); f.close()
        self.addCleanup(os.unlink, f.name)
        return f.name

    def test_operators_are_found_in_code_not_in_comments_or_strings(self):
        p = self.write("import { a } from './a';\n// if (x === 1) true\nconst s = 'a === b && true';\nexport const f = (n: number) => n >= 3 && n !== 7;\n")
        _, ms = mutate.mutants(p)
        names = sorted({m[1] for m in ms})
        self.assertEqual(names, ['!== to ===', '&& to ||', '>= to >', 'number + 1'])
        self.assertTrue(all(m[0] == 3 for m in ms))   # only the last line

    def test_numbers_with_separators_and_property_names_are_left_alone(self):
        p = self.write("export const x = { baseMs: 1_000, a: obj.v2 };\n")
        _, ms = mutate.mutants(p)
        self.assertEqual(ms, [])


if __name__ == '__main__':
    unittest.main()
