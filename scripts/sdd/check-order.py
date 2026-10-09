#!/usr/bin/env python3
"""check-order.py [order-file ...]: does each order file build every capability after the ones it depends on?

Dependencies come from the specs themselves: the "**Depends on**" line, and for the capabilities that list what they
consume (S40, S41, S48 "Requires"; the web specs' "What the backend guarantees" and "Requires"). Infrastructure specs
list their consumers in "Requires", so those lists are not read. Prints violations (a capability placed before something
it needs) and exits 1 if there are any. Default: every file in scripts/sdd/orders/.
"""
import glob, os, re, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
ID = re.compile(r'\b[SWJ]\d{2}\b')
CONSUMER_STYLE = {'S40', 'S41', 'S48', 'W01', 'W02', 'W03', 'W04', 'W05', 'W06', 'W07'}


def dependencies():
    deps = {}
    for f in sorted(glob.glob(os.path.join(ROOT, 'specs', '*', '*', 'spec.md'))):
        sid = os.path.basename(os.path.dirname(f)).split('-')[0]
        text = open(f).read()
        found = set()
        m = re.search(r'^\*\*(?:Depends on|Dependencies)\*\*:?\s*(.*)$', text, re.M | re.I)
        if m:
            found |= set(ID.findall(m.group(1)))
        if sid in CONSUMER_STYLE:
            m = re.search(r'^### Requires\s*$(.*?)(?=^### |^## |\Z)', text, re.M | re.S)
            if m:
                found |= set(ID.findall(m.group(1)))
            m = re.search(r'What the backend guarantees[^:]*:(.*)', text)
            if m:
                found |= set(ID.findall(m.group(1)))
        deps[sid] = found - {sid}
    # Web specs list each other in "Requires" (inverse links); between web specs only the shell-first order matters.
    web = {'W01', 'W02', 'W03', 'W04', 'W05', 'W06', 'W07'}
    for w in web:
        deps[w] = {d for d in deps.get(w, set()) if d not in web}
    # A backend capability asking the web app to adapt (S48 "Requires W01/W02") is not a build prerequisite.
    for k in deps:
        if k[0] == 'S':
            deps[k] = {d for d in deps[k] if d[0] == 'S'}
    return deps


def check(path, deps):
    order = [l.strip() for l in open(path) if l.strip() and not l.startswith('#') and not l.startswith('!STOP')]
    pos = {x: i for i, x in enumerate(order)}
    bad = []
    for x in order:
        for d in sorted(deps.get(x, ())):
            if d in pos and pos[d] > pos[x]:
                bad.append('%s is built before %s, which it needs' % (x, d))
    return bad


def main():
    files = sys.argv[1:] or sorted(glob.glob(os.path.join(ROOT, 'scripts', 'sdd', 'orders', '*.txt')))
    deps = dependencies()
    status = 0
    for f in files:
        bad = check(f, deps)
        print('%s: %s' % (os.path.basename(f), 'ok' if not bad else '%d violation(s)' % len(bad)))
        for b in bad:
            print('  ' + b)
        status |= bool(bad)
    return status


sys.exit(main())
