#!/usr/bin/env python3
"""Mutation testing for a TypeScript source file: do the tests notice when the code is wrong?

  mutate.py <source.ts> [--spec <spec.ts>] [--max N] [--min-score 0.6] [--timeout S]

It makes small changes to the file, one at a time (a comparison flipped, && swapped with ||, true with false, a number plus one, a + with a -), runs the unit spec of
the file after each change, and reports which changes the tests did NOT notice ("survivors"). A survivor means: the tests pass although the code is wrong, so
that line is not really tested. The score is killed / (killed + survived). Mutants that do not compile are skipped. The file is always restored.

Why in-house: Stryker needs the path aliases and ts-jest of this repository wired by hand; this is 150 lines with no dependencies. Same idea, fewer features.
`--spec` defaults to the sibling `<name>.spec.ts` or a spec in the same folder that imports the file. Needs `pnpm`/`npx jest` in packages/backend.
"""
import hashlib
import os
import random
import re
import shutil
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
BACKEND = os.path.join(ROOT, 'packages', 'backend')

# (name, regex on a code line, replacement); applied to the first/each occurrence outside strings and comments
OPERATORS = [
    ('=== to !==', r'===', '!=='), ('!== to ===', r'!==', '==='),
    ('>= to >', r'>=', '>'), ('<= to <', r'<=', '<'), ('> to >=', r'(?<![-=>])>(?![=>])', '>='), ('< to <=', r'(?<![<-])<(?![=<])', '<='),
    ('&& to ||', r'&&', '||'), ('|| to &&', r'\|\|', '&&'),
    ('true to false', r'\btrue\b', 'false'), ('false to true', r'\bfalse\b', 'true'),
    ('+ to -', r'(?<=\w) \+ (?=\w)', ' - '), ('- to +', r'(?<=\w) - (?=\w)', ' + '),
    ('* to /', r'(?<=\w) \* (?=\w)', ' / '),
    ('number + 1', r'(?<![\w.\'"`$])(\d{1,6})(?![\w.\'"`])', lambda m: str(int(m.group(1)) + 1)),
]


def code_lines(lines):
    """indexes of lines that are code: not comments, imports, types, decorators or blank"""
    out, in_block = [], False
    for i, l in enumerate(lines):
        s = l.strip()
        if in_block:
            in_block = '*/' not in s
            continue
        if s.startswith('/*'):
            in_block = '*/' not in s
            continue
        if not s or s.startswith(('//', '*', 'import ', 'export type', 'export interface', 'interface ', 'type ', '@')) or s.startswith(('}', ')')) and len(s) < 3:
            continue
        out.append(i)
    return out


def strip_strings(line):
    return re.sub(r"'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|`(?:\\.|[^`\\])*`", lambda m: ' ' * len(m.group(0)), line)


def mutants(path):
    lines = open(path, encoding='utf-8').read().split('\n')
    out = []
    for i in code_lines(lines):
        masked = strip_strings(lines[i]).split('//')[0]
        for name, pat, rep in OPERATORS:
            for m in re.finditer(pat, masked):
                new = lines[i][:m.start()] + (rep(m) if callable(rep) else rep) + lines[i][m.end():]
                if new != lines[i]:
                    out.append((i, name, new))
    return lines, out


def find_spec(src):
    d, base = os.path.dirname(src), os.path.splitext(os.path.basename(src))[0]
    cand = os.path.join(d, base + '.spec.ts')
    if os.path.exists(cand):
        return cand
    for f in sorted(os.listdir(d)):
        if f.endswith('.spec.ts') and re.search(r"from '\./" + re.escape(base) + "'", open(os.path.join(d, f), encoding='utf-8').read()):
            return os.path.join(d, f)
    return None


def run_spec(spec, timeout):
    r = subprocess.run(['npx', 'jest', os.path.relpath(spec, BACKEND), '--silent', '--coverage=false', '--forceExit'], cwd=BACKEND, capture_output=True, text=True, timeout=timeout,
                       env={**os.environ, 'NODE_OPTIONS': '--experimental-vm-modules', 'NODE_ENV': 'test'})
    return r.returncode, r.stdout + r.stderr


def main(argv):
    if not argv or argv[0].startswith('-'):
        print(__doc__)
        return 2
    src = os.path.abspath(argv[0])
    spec = os.path.abspath(argv[argv.index('--spec') + 1]) if '--spec' in argv else find_spec(src)
    mx = int(argv[argv.index('--max') + 1]) if '--max' in argv else 25
    min_score = float(argv[argv.index('--min-score') + 1]) if '--min-score' in argv else 0.0
    timeout = int(argv[argv.index('--timeout') + 1]) if '--timeout' in argv else 120
    if not spec:
        print(f'no unit spec found for {os.path.relpath(src, ROOT)} (use --spec)', file=sys.stderr)
        return 2
    t0 = time.time()
    rc, out = run_spec(spec, timeout * 3)
    if rc != 0:
        print(f'the spec fails BEFORE any change; fix it first:\n{out[-600:]}', file=sys.stderr)
        return 2
    base_s = time.time() - t0
    lines, all_m = mutants(src)
    random.Random(int(hashlib.sha256(src.encode()).hexdigest()[:8], 16)).shuffle(all_m)
    chosen = sorted(all_m[:mx], key=lambda m: m[0])
    print(f'{os.path.relpath(src, ROOT)}: {len(all_m)} possible changes, trying {len(chosen)} (the spec takes {base_s:.0f} s)')
    backup = src + '.mutate-orig'
    shutil.copy(src, backup)
    killed = survived = invalid = 0
    survivors = []
    try:
        for i, name, new in chosen:
            mutated = lines[:i] + [new] + lines[i + 1:]
            open(src, 'w', encoding='utf-8').write('\n'.join(mutated))
            try:
                rc, out = run_spec(spec, timeout)
            except subprocess.TimeoutExpired:
                rc, out = 1, 'timeout'
            if rc == 0:
                survived += 1
                survivors.append(f'line {i + 1}: {name}:  {lines[i].strip()[:90]}   ->   {new.strip()[:90]}')
            elif re.search(r'error TS\d+|SyntaxError', out) and 'Tests:' not in out:
                invalid += 1
            else:
                killed += 1
    finally:
        shutil.move(backup, src)
    total = killed + survived
    score = killed / total if total else 1.0
    print(f'killed {killed}, survived {survived}, did not compile {invalid}; score {score:.0%}')
    for s in survivors:
        print('  SURVIVED ' + s)
    if survivors:
        print('A survivor means the tests pass although the code is wrong there: add a test that fails for that change, or delete the code if nothing needs it.')
    return 1 if score < min_score else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
