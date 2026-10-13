#!/usr/bin/env python3
"""Test-integrity checks for the SDD gate (run from the repo root).

  check-tests.py scenarios <kind> <test-plan.md> <spec-id> <scope-dir>...
      Every scenario row of the test plan that names a test (any non-dash cell besides the scenario and the
      "proven by another capability" column) must have a test under the scope whose title line carries both the capability and the scenario ID,
      e.g. it('S13 AS-12: ...') (IDs like AS-01 repeat across capabilities, so both are required).
  check-tests.py integrity <scope-dir>...
      No `.skip`, `xit`, `xdescribe`, `it.todo` may be added, and a test must not be weakened. Tests may be replaced, split, merged, renamed
      or deleted: what must not disappear is a SCENARIO. Every scenario id (`S34 AS-12`) that a test file carried at HEAD must still be carried by
      some test file after the change, or be retired in the spec folder's `retired-scenarios.md` (one line: `S34 AS-12: why`).
      A file that loses `it(`/`expect(` calls is a finding only when it also loses a scenario id that no other file now carries; a file without scenario ids
      is judged by its call counts, and may be deleted only with its subject.
Exit 1 with a list of findings, else 0.
"""
import os, re, subprocess, sys
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

def deferred_scenarios(plan, max_priority):
    """AS ids that only stories of a lower priority than max_priority cover (the pass defers them).

    Stories are the "### User Story N ... (Priority: Pn)" sections of spec.md. A scenario counts as deferred when every
    story that cites it is below the limit; one that no story cites stays required."""
    spec = Path(plan).with_name('spec.md')
    if not max_priority or not spec.exists():
        return set()
    parts = re.split(r'(?m)^###\s+User Story\s+\d+[^\n]*?\(Priority:\s*P(\d)\)[^\n]*\n', spec.read_text())
    cited_by = {}
    for i in range(1, len(parts), 2):
        body = re.split(r'(?m)^##\s', parts[i + 1])[0]
        body = re.split(r'(?m)^###\s', body)[0]
        # "(S48 AS-44, AS-59.)" names another capability's scenarios, not this spec's own
        body = re.sub(r'\([^()]*\bS\d+ AS-\d+[^()]*\)', '', body)
        for ref in set(re.findall(r'\bAS-0*(\d+)\b', body)):
            cited_by.setdefault(int(ref), []).append(int(parts[i]))
    return {n for n, pri in cited_by.items() if all(p > max_priority for p in pri)}


def scenarios(kind, plan, spec_id, scopes):
    text = Path(plan).read_text()
    lim = os.environ.get('MAX_PRIORITY', '')
    deferred = deferred_scenarios(plan, int(lim[-1]) if lim[-1:].isdigit() else 0)
    sid_re = re.compile(r'\b%s\b' % re.escape(spec_id))
    # A scenario is carried by a line holding both IDs ("S54 AS-12: ..."), or, for table-driven tests (it.each rows),
    # by a file that names the capability somewhere (its describe title or header) and the scenario ID on any line.
    lines, file_texts = [], []
    for f in test_files(scopes):
        t = f.read_text(errors='ignore')
        lines += t.splitlines()
        if sid_re.search(t):
            file_texts.append(t)
    missing = []
    for line in text.splitlines():
        m = re.match(r'^\|\s*(AS-\d+)\b', line)
        if not m:
            continue
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        tested = cells[1:]
        if kind in ('web', 'journey'):
            tested = tested[:-1] if kind == 'web' else tested[:1]   # last column = proven by another capability
        # "static: check:no-request-scope" rows are proven by a static gate, not by a test that carries the ID.
        tested = [c for c in tested if not c.lower().startswith('static')]
        if all(c in DASH for c in tested):
            continue
        sid = m.group(1)
        n = int(sid.split('-')[1])
        if n in deferred:
            continue
        as_re = re.compile(r'\bAS-0*%d\b' % n)
        if not (any(sid_re.search(l) and as_re.search(l) for l in lines) or any(as_re.search(t) for t in file_texts)):
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

SCENARIO = re.compile(r"\b([SWJ]\d{2})((?:\s+AS-\d+)+)")


def scenario_ids(text):
    """'S34 AS-01 AS-13: ...' -> {'S34 AS-01', 'S34 AS-13'}"""
    out = set()
    for m in SCENARIO.finditer(text):
        out |= {f'{m.group(1)} {a}' for a in re.findall(r'AS-\d+', m.group(2))}
    return out


def retired(scopes):
    """Scenario ids that a spec folder declares retired: `retired-scenarios.md` next to spec.md, lines like `S34 AS-12: why it no longer applies`."""
    out = set()
    for f in Path('specs').rglob('retired-scenarios.md'):
        out |= scenario_ids(f.read_text(errors='ignore'))
    return out


def tree_scenarios(scopes, exclude=()):
    ids = set()
    for f in test_files(scopes):
        if str(f) in exclude:
            continue
        ids |= scenario_ids(f.read_text(errors='ignore'))
    return ids


def integrity(scopes):
    bad = []
    r = subprocess.run(['git', 'diff', '--name-only', '--diff-filter=D', 'HEAD', '--', *scopes], capture_output=True, text=True)
    deleted = set(r.stdout.split())
    kept = tree_scenarios(scopes) | retired(scopes)
    for f in test_files(scopes):
        now = f.read_text(errors='ignore')
        before = git_show(str(f))
        if WEAK.search(now) and not (before and len(WEAK.findall(before)) >= len(WEAK.findall(now))):
            bad.append(f'{f}: skipped/todo test added')
        if before is None:
            continue
        if len(COUNT.findall(now)) < len(COUNT.findall(before)):
            lost = scenario_ids(before) - kept
            if lost or not scenario_ids(before):
                bad.append(f'{f}: fewer it()/expect() calls than at HEAD ({len(COUNT.findall(now))} < {len(COUNT.findall(before))})'
                           + (f'; scenarios no test carries any more: {", ".join(sorted(lost))}' if lost else ''))
    # a test file may go with the module it tested (foo.test.ts next to a deleted foo.ts), or be replaced: then every scenario id it carried is carried elsewhere
    def subject_deleted(p):
        stem = TEST_FILE.sub('', p)
        return any(stem + ext in deleted for ext in ('.ts', '.tsx'))
    for p in sorted(deleted):
        if not TEST_FILE.search(p) or subject_deleted(p):
            continue
        before = git_show(p) or ''
        ids = scenario_ids(before)
        if not ids:
            bad.append(f'{p}: test file deleted, and it carried no scenario id, so nothing proves that another test replaces it (add the scenario id to the replacing test titles, or delete it together with its subject)')
            continue
        lost = ids - kept
        if lost:
            bad.append(f'{p}: test file deleted and these scenarios are in no test any more: {", ".join(sorted(lost))} (carry them in the replacing tests, or retire them in specs/<capability>/retired-scenarios.md with a reason)')
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
