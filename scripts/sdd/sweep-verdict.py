#!/usr/bin/env python3
"""sweep-verdict.py <sweep log>: which failing backend e2e suites of a checkpoint sweep count.

A suite under libs/domains/<domain>/ belongs to the capabilities of that domain (scripts/sdd/capabilities.tsv, column 2). If none of them
is built yet (no .implemented / .implemented-P1 marker in its spec folder), the suite is an old test of a feature that is still to be
rebuilt: it is listed as "not counted" and does not fail the checkpoint. Every other failing suite counts (infrastructure, common,
composition, apps, and domains with a built capability). Prints one line per failing suite; exit 1 if any counts.
"""
import csv, glob, os, re, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))


def built_domains():
    rows = {}
    with open(os.path.join(ROOT, 'scripts', 'sdd', 'capabilities.tsv')) as f:
        for r in csv.reader(f, delimiter='\t'):
            if r and re.fullmatch(r'[SWJ]\d{2}', r[0]) and len(r) > 1:
                rows[r[0]] = r[1]
    built = set()
    for d in glob.glob(os.path.join(ROOT, 'specs', '*', '*')):
        cid = os.path.basename(d).split('-')[0]
        if cid in rows and any(os.path.exists(os.path.join(d, m)) for m in ('.implemented', '.implemented-P1')):
            built.add(rows[cid])
    return built


def main(log):
    text = re.sub(r'\x1b\[[0-9;]*m', '', open(log, errors='replace').read())
    failing = sorted(set(re.findall(r'^FAIL (\S+)', text, re.M)))
    built = built_domains()
    counted = 0
    for path in failing:
        m = re.match(r'libs/domains/([^/]+)/', path)
        domain = m.group(1) if m else None
        if domain and domain not in built:
            print(f'not counted (no built capability in domain "{domain}"): {path}')
        else:
            print(f'FAILED: {path}')
            counted += 1
    if not failing:
        print('no failing suites')
    return 1 if counted else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
