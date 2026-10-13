#!/usr/bin/env python3
"""failures.py: reads the logs of the build loop and says what failed. Used by the checkpoint repair agent and the flake signal.

  failures.py names <log>                       one failing test (or suite that did not run) per line
  failures.py digest <log> [--label L] [--results-dir DIR] [--max-chars N]
                                                the text a repair agent gets for a failed checkpoint: failing suites and tests with their first
                                                assertion lines, Playwright failures, crashes, the page snapshots (error-context.md), the log's tail
  failures.py flake-note <log> --label L [--append gaps.md] [--date D]
                                                the markdown block for a gate or checkpoint that failed and then passed with a repair that changed
                                                no code; with --append it is added to that file (the heading once, then one entry per call)

Understands Jest (`FAIL path`, `  ● suite › test`), Playwright's list reporter (`  1) [chromium] › file:1:1 › title`, `Error Context:`), tsc errors,
and the lines checkpoint.sh and sweep-verdict.py add. Colors are stripped first."""
import argparse
import datetime
import glob
import os
import re
import sys

ANSI = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')
FAIL_SUITE = re.compile(r'^FAIL (\S+)')
JEST_TEST = re.compile(r'^  ● (.+?)\s*$')
PW_FAIL = re.compile(r'^\s+\d+\) (\[[^\]]+\] › \S+?:\d+:\d+ › .+?)(?:\s+─+)?\s*$')
PW_CONTEXT = re.compile(r'^\s+Error Context: (\S+error-context\.md)')
TSC = re.compile(r'^(\S+\.tsx?)[(:](\d+)[,:](\d+)\)?:? ?-? ?error (TS\d+): (.*)$')
NOT_COUNTED = re.compile(r'^not counted \(no built capability in domain "[^"]+"\): (\S+)')
STOP_BLOCK = re.compile(r'^(PASS|FAIL) |^Test Suites:|^Tests:|^Summary of all failing tests|^  ● |^\s+\d+ (failed|passed|flaky|skipped)')
CRASH = re.compile(r'^(a sweep batch ended without a summary.*|no backend e2e specs found.*|backend e2e sweep FAILED|web sweep FAILED|.*heap out of memory.*)$')


def clean(text):
    return ANSI.sub('', text)


def _detail(lines, start, limit=10):
    """Lines after a failure heading: skip blanks and node_modules frames, stop at the next block."""
    out = []
    for ln in lines[start:start + 80]:
        if STOP_BLOCK.match(ln) or PW_FAIL.match(ln):
            break
        if re.match(r'^\s+at .*(node_modules|node:internal)', ln) or not ln.strip():
            continue
        out.append(ln.rstrip()[:200])
        if len(out) >= limit:
            break
    return out


def parse(text):
    """Returns a dict: tests [{name, suite, detail}], suites [{path}] (FAIL lines), web [{name, detail}], tsc [str], crashes [str],
    not_counted {path}, counted {path}, contexts [path]."""
    lines = clean(text).split('\n')
    r = {'tests': [], 'suites': [], 'web': [], 'tsc': [], 'crashes': [], 'not_counted': set(), 'counted': set(), 'contexts': []}
    suite, seen_tests, seen_web, seen_suites = None, set(), set(), set()
    for i, ln in enumerate(lines):
        m = NOT_COUNTED.match(ln)
        if m:
            r['not_counted'].add(m.group(1))
            continue
        if ln.startswith('FAILED: '):
            r['counted'].add(ln[8:].strip())
            continue
        m = FAIL_SUITE.match(ln)
        if m:
            suite = m.group(1)
            if suite not in seen_suites:
                seen_suites.add(suite)
                r['suites'].append({'path': suite})
            continue
        if ln.startswith(('PASS ', 'Test Suites:')):
            suite = None if ln.startswith('PASS ') else suite
        m = JEST_TEST.match(ln)
        if m and not m.group(1).startswith('Console'):
            name = m.group(1)
            if name == 'Test suite failed to run':
                name = f'{suite or "?"}: suite failed to run'
            key = (suite, name)
            if key not in seen_tests:
                seen_tests.add(key)
                r['tests'].append({'name': name, 'suite': suite, 'detail': _detail(lines, i + 1)})
            continue
        m = PW_FAIL.match(ln)
        if m:
            name = re.sub(r' \(retry #\d+\)$', '', m.group(1))
            if name not in seen_web:
                seen_web.add(name)
                r['web'].append({'name': name, 'detail': _detail(lines, i + 1)})
            continue
        m = PW_CONTEXT.match(ln)
        if m and m.group(1) not in r['contexts']:
            r['contexts'].append(m.group(1))
            continue
        m = TSC.match(ln.strip())
        if m and len(r['tsc']) < 30:
            r['tsc'].append(f'{m.group(1)}({m.group(2)},{m.group(3)}): {m.group(4)} {m.group(5)}'[:200])
            continue
        if CRASH.match(ln.strip()) and ln.strip() not in r['crashes']:
            r['crashes'].append(ln.strip())
    return r


def counted(r, tests):
    """Drop what the sweep does not count: tests of suites in domains with no built capability."""
    return [t for t in tests if not (t.get('suite') and t['suite'] in r['not_counted'])]


def names(text):
    r = parse(text)
    out = [t['name'] for t in counted(r, r['tests'])]
    with_tests = {t['suite'] for t in r['tests']}
    out += [s['path'] for s in r['suites'] if s['path'] not in with_tests and s['path'] not in r['not_counted']]
    out += [w['name'] for w in r['web']]
    out += [f'tsc: {x}' for x in r['tsc'][:10]]
    out += r['crashes']
    seen = set()
    return [n for n in out if not (n in seen or seen.add(n))]


def snapshots(r, results_dir, base=None):
    """error-context.md files: the ones the log names, then any under results_dir; existing files only, newest first."""
    found = []
    for c in r['contexts']:
        for cand in ([c] if os.path.isabs(c) else [os.path.join(base or '', c), os.path.join(results_dir or '', os.path.relpath(c, 'test-results'))]):
            if cand and os.path.isfile(cand) and cand not in found:
                found.append(cand)
                break
    if results_dir:
        for f in sorted(glob.glob(os.path.join(results_dir, '**', 'error-context.md'), recursive=True), key=os.path.getmtime, reverse=True):
            if f not in found:
                found.append(f)
    return found


def digest(text, label='', results_dir=None, max_chars=12000, base=None):
    r = parse(text)
    tests = counted(r, r['tests'])
    out = [f'Checkpoint {label} failed.' if label else 'The checkpoint failed.']
    if r['counted']:
        out.append('Backend e2e suites that fail and count (sweep-verdict):')
        out += [f'- {p}' for p in sorted(r['counted'])]
    if r['not_counted']:
        out.append(f'({len(r["not_counted"])} failing suites belong to domains with no built capability: not counted, not yours to fix.)')
    if tests:
        out.append('Failing backend tests, with the first lines of each failure:')
        for t in tests[:25]:
            out.append(f'- {t["name"]}' + (f'   [{t["suite"]}]' if t['suite'] else ''))
            out += [f'    {d.strip()}' for d in t['detail'][:6]]
        if len(tests) > 25:
            out.append(f'- ... and {len(tests) - 25} more')
    if r['web']:
        out.append('Failing browser (Playwright) tests:')
        for w in r['web'][:20]:
            out.append(f'- {w["name"]}')
            out += [f'    {d.strip()}' for d in w['detail'][:6]]
    if r['tsc']:
        out.append('Compiler errors:')
        out += [f'- {x}' for x in r['tsc'][:10]]
    if r['crashes']:
        out.append('Crashes (a process that died is a failure, not a flaky test):')
        out += [f'- {c}' for c in r['crashes']]
    if len(out) == 1:
        out.append('No failing test was recognized in the log; read the tail below (it may be the living specification check or the flow script).')
    snaps = snapshots(r, results_dir, base)
    if snaps:
        out.append('Page snapshots Playwright saved for failed browser tests (read them: they show what the page looked like):')
        out += [f'- {s}' for s in snaps[:8]]
        for s in snaps[:3]:
            try:
                head = open(s, errors='replace').read().split('\n')[:30]
            except OSError:
                continue
            out.append(f'--- first lines of {s} ---')
            out += [h[:200] for h in head]
    out.append('--- the last lines of the checkpoint log ---')
    out += [ln[:240] for ln in clean(text).rstrip('\n').split('\n')[-40:]]
    return '\n'.join(out)[:max_chars]


FLAKE_HEADING = '## Flaky tests (passed after a repair that changed no code)'


def flake_note(text, label, date=None):
    ns = names(text)
    day = date or datetime.date.today().isoformat()
    body = [f'- {day} {label}: failed, then passed after a repair attempt that changed no code. Not a fix: a flake. Failed before:']
    body += [f'  - {n}' for n in ns[:20]] or ['  - (no test name could be read from the log)']
    if len(ns) > 20:
        body.append(f'  - ... and {len(ns) - 20} more')
    return '\n'.join(body)


def append_flake(path, note):
    cur = open(path).read() if os.path.exists(path) else ''
    sep = '' if not cur or cur.endswith('\n') else '\n'
    if FLAKE_HEADING in cur:
        # keep the entries together: insert before the next heading after ours, or at the end
        head_at = cur.index(FLAKE_HEADING)
        nxt = re.search(r'^## ', cur[head_at + len(FLAKE_HEADING):], re.M)
        pos = head_at + len(FLAKE_HEADING) + nxt.start() if nxt else len(cur)
        new = cur[:pos].rstrip('\n') + '\n' + note + '\n' + ('\n' + cur[pos:] if nxt else '')
    else:
        new = cur + sep + ('\n' if cur else '') + FLAKE_HEADING + '\n' + note + '\n'
    with open(path, 'w') as f:
        f.write(new)


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('names'); p.add_argument('log')
    p = sub.add_parser('digest'); p.add_argument('log'); p.add_argument('--label', default=''); p.add_argument('--results-dir', default=None)
    p.add_argument('--max-chars', type=int, default=12000)
    p = sub.add_parser('flake-note'); p.add_argument('log'); p.add_argument('--label', required=True); p.add_argument('--append', default=None); p.add_argument('--date', default=None)
    a = ap.parse_args(argv)
    text = open(a.log, errors='replace').read() if os.path.exists(a.log) else ''
    if a.cmd == 'names':
        print('\n'.join(names(text)))
    elif a.cmd == 'digest':
        print(digest(text, a.label, a.results_dir, a.max_chars, base=os.path.dirname(a.results_dir) if a.results_dir else None))
    else:
        note = flake_note(text, a.label, a.date)
        if a.append:
            append_flake(a.append, note)
        else:
            print(FLAKE_HEADING + '\n' + note)
    return 0


if __name__ == '__main__':
    sys.exit(main())
