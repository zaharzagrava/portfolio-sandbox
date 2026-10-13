#!/usr/bin/env python3
"""digest.py [lessons.md] [--max-lines N]: the failure classes and one-line prevention rules of docs/lessons.md,
at most 40 lines, for the agents' prompts ("known failure classes: check these first"). Exit 0 always when the file parses;
the output is plain text, one class per header line, one rule per lesson."""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

MAX_LINE = 170


def clip(s, n=MAX_LINE):
    s = ' '.join(s.split())
    return s if len(s) <= n else s[:n - 1].rstrip() + '…'


def build(lessons, max_lines=40):
    by_class = {}
    for les in lessons:
        by_class.setdefault(les.cls, []).append(les)
    rep = common.repeats(lessons)
    order = [c for c in common.CLASSES if c in by_class] + sorted(c for c in by_class if c not in common.CLASSES)
    head = 'Known failure classes (docs/lessons.md): check these first.'
    # Newest first inside a class, so a cut drops the oldest rule. Open lessons say that no check exists yet.
    per = {c: sorted(by_class[c], key=lambda x: (x.date, x.id), reverse=True) for c in order}
    keep = {c: len(per[c]) for c in order}

    def render():
        out = [head]
        for c in order:
            n = len(by_class[c])
            r = len(rep.get(c, []))
            out.append(f'{c} ({n} lesson{"s" if n != 1 else ""}{f", {r} repeat" + ("s" if r != 1 else "") if r else ""}):')
            for les in per[c][:keep[c]]:
                tag = ' [open: no check yet]' if les.status == 'open' else ''
                out.append(f'- {les.id} {clip(les.rule)}{tag}')
            if keep[c] < len(per[c]):
                out.append(f'- (+{len(per[c]) - keep[c]} older in docs/lessons.md)')
        return out

    out = render()
    while len(out) > max_lines and any(keep[c] > 1 for c in order):
        # drop one rule from the class that shows the most
        c = max(order, key=lambda k: keep[k])
        keep[c] -= 1
        out = render()
    if len(out) > max_lines:
        out = out[:max_lines - 1] + ['- (cut: see docs/lessons.md)']
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('file', nargs='?', default=common.LESSONS)
    ap.add_argument('--max-lines', type=int, default=40)
    a = ap.parse_args(argv)
    if not os.path.exists(a.file):
        return 0  # no lessons yet: print nothing, the prompt simply has no block
    lessons, problems = common.load(a.file)
    for p in problems:
        print(f'lessons: {p}', file=sys.stderr)
    if not lessons:
        return 0
    print('\n'.join(build(lessons, min(a.max_lines, 40))))
    return 0


if __name__ == '__main__':
    sys.exit(main())
