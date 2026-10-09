#!/usr/bin/env python3
"""Test-integrity checks for the SDD gate (run from the repo root).

  check-tests.py scenarios <kind> <test-plan.md> <spec-id> <scope-dir>...
      Every scenario row of the test plan that names a test (any non-dash cell besides the scenario and the
      "proven by another capability" column) must have a test under the scope whose title line carries both the capability and the scenario ID,
      e.g. it('S13 AS-12: ...') (IDs like AS-01 repeat across capabilities, so both are required).
  check-tests.py integrity <scope-dir>...
      Tests that already exist at HEAD must not lose `it(`/`test(`/`expect(` calls, and no `.skip`, `xit`,
      `xdescribe`, `it.todo` may be added. Guards against "making the test pass" by weakening it.
Exit 1 with a list of findings, else 0.
"""
import re, subprocess, sys
from pathlib import Path

TEST_FILE = re.compile(r'\.(e2e-spec|spec|test|journey-spec)\.tsx?$')
DASH = {'—', '-', '–', ''}

def test_files(scopes):
    out = []
    for s in scopes:
        p = Path(s)
        if p.is_file():
            out.append(p)
        elif p.is_dir():
            out += [f for f in p.rglob('*') if f.is_file() and TEST_FILE.search(f.name) and 'node_modules' not in f.parts]
    return sorted(set(out))

def scenarios(kind, plan, spec_id, scopes):
    text = Path(plan).read_text()
    lines = [l for f in test_files(scopes) for l in f.read_text(errors='ignore').splitlines()]
    sid_re = re.compile(r'\b%s\b' % re.escape(spec_id))
    missing = []
    for line in text.splitlines():
        m = re.match(r'^\|\s*(AS-\d+)\b', line)
        if not m:
            continue
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        tested = cells[1:]
        if kind in ('web', 'journey'):
            tested = tested[:-1] if kind == 'web' else tested[:1]   # last column = proven by another capability
        if all(c in DASH for c in tested):
            continue
        sid = m.group(1)
        n = int(sid.split('-')[1])
        as_re = re.compile(r'\bAS-0*%d\b' % n)
        if not any(sid_re.search(l) and as_re.search(l) for l in lines):
            missing.append(sid)
    if missing:
        print('scenarios in test-plan.md with no test carrying their ID (name tests it(\'%s AS-NN: ...\')): ' % spec_id + ', '.join(missing))
        return 1
    return 0

COUNT = re.compile(r'\b(?:it|test)(?:\.each\([^)]*\))?\s*\(|\bexpect\s*\(')
WEAK = re.compile(r'\b(?:it|test|describe)\.skip\b|\bxit\s*\(|\bxdescribe\s*\(|\b(?:it|test)\.todo\b')

def git_show(path):
    r = subprocess.run(['git', 'show', f'HEAD:{path}'], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None

def integrity(scopes):
    bad = []
    for f in test_files(scopes):
        now = f.read_text(errors='ignore')
        before = git_show(str(f))
        if WEAK.search(now) and not (before and len(WEAK.findall(before)) >= len(WEAK.findall(now))):
            bad.append(f'{f}: skipped/todo test added')
        if before is None:
            continue
        if len(COUNT.findall(now)) < len(COUNT.findall(before)):
            bad.append(f'{f}: fewer it()/expect() calls than at HEAD ({len(COUNT.findall(now))} < {len(COUNT.findall(before))})')
    # tests deleted outright
    r = subprocess.run(['git', 'diff', '--name-only', '--diff-filter=D', 'HEAD', '--', *scopes], capture_output=True, text=True)
    bad += [f'{p}: test file deleted' for p in r.stdout.split() if TEST_FILE.search(p)]
    if bad:
        print('test integrity: ' + '; '.join(bad))
        return 1
    return 0

if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'scenarios':
        sys.exit(scenarios(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:]))
    if cmd == 'integrity':
        sys.exit(integrity(sys.argv[2:]))
    sys.exit('usage: see module docstring')
