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


def entries(path):
    """[(index, id, limit or None, needs or None)] in file order; '# needs: S01 S02' on a limited entry declares what its pass needs."""
    out = []
    for line in open(path):
        line = line.rstrip('\n')
        if not line.strip() or line.lstrip().startswith('#') or line.startswith('!STOP'):
            continue
        body, _, comment = line.partition('#')
        ident, _, limit = body.split()[0].partition(':')
        needs = None
        m = re.search(r'needs:\s*(.*)', comment)
        if m:
            needs = set(ID.findall(m.group(1)))
        out.append((len(out), ident, limit or None, needs))
    return out


def check(path, deps):
    """A whole-spec entry must come after the whole-spec entry of everything its spec depends on.
    A limited entry (S10:P1) must come after what its comment says it needs ('# needs: S05'), in any form, and its own
    plain entry must come later. Every capability needs exactly one plain entry."""
    ents = entries(path)
    first = {}      # id -> index of its first entry of any kind
    full = {}       # id -> index of its plain entry
    limited = {}    # id -> index of its limited entry
    bad = []
    for i, ident, limit, needs in ents:
        first.setdefault(ident, i)
        if limit:
            limited[ident] = i
        elif ident in full:
            bad.append('%s has two plain entries' % ident)
        else:
            full[ident] = i
    for i, ident, limit, needs in ents:
        if limit:
            for d in sorted(needs if needs is not None else deps.get(ident, ())):
                if d not in first or first[d] > i:
                    bad.append('%s:%s is built before %s, which its pass needs' % (ident, limit, d))
            if ident in full and full[ident] < i:
                bad.append('%s:%s comes after its own plain entry' % (ident, limit))
        else:
            for d in sorted(deps.get(ident, ())):
                if d in full and full[d] > i:
                    bad.append('%s is built before %s, which it needs' % (ident, d))
                elif d not in full and d in first:
                    bad.append('%s needs %s, which only has a limited entry' % (ident, d))
    for ident in first:
        if ident not in full:
            bad.append('%s has no plain (whole-spec) entry' % ident)
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
