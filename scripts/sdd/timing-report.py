#!/usr/bin/env python3
"""timing-report.py <timing.jsonl>... [--top N] [--markdown FILE]

Turns the timing lines written during a test run (TEST_TIMING=1; backend: packages/backend/test/timing-environment.cjs, browser:
packages/web/tests/support/timing-reporter.ts) into a short report: where the time goes by phase, the slowest files, the slowest tests.
The kind of each line is detected (a backend line has "beforeEach", a browser line has "project").
"""
import argparse, collections, json, sys


def load(paths):
    be, fe = [], []
    for p in paths:
        for raw in open(p, encoding='utf-8', errors='replace'):
            raw = raw.strip()
            if not raw:
                continue
            try:
                d = json.loads(raw)
            except ValueError:
                continue
            (fe if 'project' in d else be).append(d)
    return be, fe


def mins(ms):
    return f'{ms / 60000:.1f} min' if ms >= 60000 else f'{ms / 1000:.1f} s'


def backend(rows, top):
    out = []
    phases = collections.OrderedDict([('load', 0), ('beforeAll', 0), ('beforeEach', 0), ('tests', 0), ('afterEach', 0), ('afterAll', 0), ('other', 0)])
    total = 0
    for r in rows:
        total += r['total']
        for k in phases:
            phases[k] += r[k] if isinstance(r[k], int) else r[k]['ms']
    out.append(f'Backend e2e: {len(rows)} files, {sum(r["tests"]["n"] for r in rows)} tests, {mins(total)} summed over files')
    for k, v in phases.items():
        out.append(f'  {k:11} {mins(v):>9}  {100 * v / max(total, 1):4.0f}%')
    out.append(f'Slowest {top} files:')
    for r in sorted(rows, key=lambda r: -r['total'])[:top]:
        out.append(f'  {mins(r["total"]):>8}  load {mins(r["load"])}, beforeAll {mins(r["beforeAll"]["ms"])}, beforeEach {mins(r["beforeEach"]["ms"])}/{r["beforeEach"]["n"]},'
                   f' tests {mins(r["tests"]["ms"])}/{r["tests"]["n"]}  {r["file"]}')
    tests = [(t['ms'], t['name'], r['file']) for r in rows for t in r.get('slowTests', [])]
    out.append(f'Slowest {top} tests:')
    for ms, name, f in sorted(tests, reverse=True)[:top]:
        out.append(f'  {mins(ms):>8}  {name[:90]}  [{f}]')
    cum = 0
    ordered = sorted(rows, key=lambda r: -r['total'])
    for i, r in enumerate(ordered, 1):
        cum += r['total']
        if cum >= 0.5 * total:
            out.append(f'Half of the time is in the slowest {i} of {len(rows)} files.')
            break
    return out


def browser(rows, top):
    out = []
    final = [r for r in rows]
    total = sum(r['ms'] for r in final)
    cats = collections.Counter()
    for r in final:
        for k, v in r['steps'].items():
            cats[k] += v
    stepped = sum(cats.values())
    out.append(f'Browser: {len(final)} test attempts, {mins(total)} summed over tests (2 workers = about half of that on the clock)')
    for k, v in cats.most_common():
        out.append(f'  {k:10} {mins(v):>9}  {100 * v / max(total, 1):4.0f}%')
    out.append(f'  {"test body":10} {mins(max(total - stepped, 0)):>9}  {100 * max(total - stepped, 0) / max(total, 1):4.0f}%  (not in a step)')
    byfile = collections.Counter(); n = collections.Counter()
    for r in final:
        byfile[(r['file'])] += r['ms']; n[r['file']] += 1
    out.append(f'Slowest {top} files:')
    for f, ms in byfile.most_common(top):
        out.append(f'  {mins(ms):>8}  {n[f]:3d} tests  {f}')
    out.append(f'Slowest {top} tests:')
    for r in sorted(final, key=lambda r: -r['ms'])[:top]:
        out.append(f'  {mins(r["ms"]):>8}  [{r["project"]}] {r["title"][:80]}  ({r["file"]})')
    steps = collections.Counter()
    for r in final:
        for s in r.get('slowSteps', []):
            steps[(s['category'], s['title'][:50])] += s['ms']
    out.append('Slowest kinds of step (sum of the top 3 of each test):')
    for (cat, title), ms in steps.most_common(8):
        out.append(f'  {mins(ms):>8}  {cat}: {title}')
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('files', nargs='+')
    ap.add_argument('--top', type=int, default=10)
    ap.add_argument('--markdown')
    a = ap.parse_args()
    be, fe = load(a.files)
    out = []
    if be:
        out += backend(be, a.top)
    if fe:
        out += ([''] if out else []) + browser(fe, a.top)
    if not out:
        out = ['no timing lines found']
    text = '\n'.join(out)
    print(text)
    if a.markdown:
        open(a.markdown, 'w', encoding='utf-8').write('# Test timing report\n\n```\n' + text + '\n```\n')


if __name__ == '__main__':
    main()
