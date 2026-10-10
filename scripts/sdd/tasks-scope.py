#!/usr/bin/env python3
"""tasks-scope.py <tasks.md> [P1|P2|P3|-]: count the tasks that belong to a priority-limited pass.

tasks.md is grouped in phases: "## Phase N: Setup", "Foundational", "User Story K ... (P1)", "Polish ...",
"Convergence". A pass limited to P2 covers Setup, Foundational and the story phases of priority P1 and P2; Polish,
cross-cutting and Convergence phases belong to the full pass only. With no limit ("-" or omitted) every phase counts.

Prints "<ticked> <open> <total>". With --open it prints the open task lines instead; --phases lists the phases that count.
"""
import re, sys

PHASE = re.compile(r'^##\s+Phase\s+\d+\s*[:.-]\s*(.*)$')
TASK = re.compile(r'^-\s+\[([ xX])\]\s+(.*)$')
PRIORITY = re.compile(r'\(\s*(?:Priority:\s*)?P(\d)\b')
FULL_ONLY = re.compile(r'polish|cross-cutting|final|finish|cleanup|closure|convergence|converge', re.I)


def included(title, limit):
    if limit is None:
        return True
    m = PRIORITY.search(title)
    if m:
        return int(m.group(1)) <= limit
    return not FULL_ONLY.search(title)  # Setup, Foundational: always; Polish, Convergence: full pass only


def scan(path, limit):
    phases, cur = [], None
    for line in open(path, encoding='utf-8', errors='ignore'):
        line = line.rstrip('\n')
        m = PHASE.match(line)
        if m:
            cur = {'title': m.group(1).strip(), 'tasks': []}
            phases.append(cur)
            continue
        if line.startswith('## '):  # a non-phase section (Gap coverage, Notes, ...) ends the phase
            cur = None
            continue
        t = TASK.match(line)
        if t and cur is not None:
            cur['tasks'].append((t.group(1) in 'xX', t.group(2)))
    return [p for p in phases if included(p['title'], limit)]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = {a for a in sys.argv[1:] if a.startswith('--')}
    if not args:
        print(__doc__)
        return 2
    limit = None
    if len(args) > 1 and re.fullmatch(r'P\d', args[1]):
        limit = int(args[1][1])
    try:
        phases = scan(args[0], limit)
    except FileNotFoundError:
        print('0 0 0')
        return 0
    tasks = [t for p in phases for t in p['tasks']]
    if '--phases' in flags:
        for p in phases:
            print('%d/%d  %s' % (sum(1 for d, _ in p['tasks'] if d), len(p['tasks']), p['title']))
        return 0
    if '--open' in flags:
        for done, text in tasks:
            if not done:
                print(text)
        return 0
    ticked = sum(1 for d, _ in tasks if d)
    print('%d %d %d' % (ticked, len(tasks) - ticked, len(tasks)))
    return 0


sys.exit(main())
