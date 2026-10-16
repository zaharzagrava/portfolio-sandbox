#!/usr/bin/env python3
"""defer-runtime.py <tasks.md> <capability id> [deferred-checks.md]

Ticks every OPEN task that only asks to run, record or prove a runtime check (fresh-stack run, standalone boot of the apps, the browser
or journey suite) as "deferred to the final checkpoint" and writes one line per task to specs/deferred-checks.md (lesson L-019, L-022).
The agents cannot run those on the build machine, and converge distrusts a deferred tick and adds a new "record the proofs" task after
every pass: J01 went round that circle for hours (implement, converge adds a task, implement cannot do it, doctor defers it, repeat).
Prints the ids it deferred. A task that builds or fixes something (even one that names these commands) stays open.
"""
import re, sys

PROOF = re.compile(r'runtime proofs?|fresh-run\.sh|boot-apps?\.sh|test:journeys|playwright|final checkpoint', re.I)
VERB = re.compile(r'^\W*(?:T\d+\s+)?(?:\[[^\]]*\]\s*)*(?:(?:CRITICAL|HIGH|MEDIUM|LOW)[:/ ]*)*\s*(?:run|record|prove|confirm|verify|re-?run|re-?confirm|show|capture|collect)\b', re.I)
OPEN = re.compile(r'^(- \[ \] )(T\d+)\b(.*)$')


def main(tasks, cap, checks='specs/deferred-checks.md'):
    lines = open(tasks, encoding='utf-8').read().split('\n')
    done = []
    for i, line in enumerate(lines):
        m = OPEN.match(line)
        if not m:
            continue
        body = m.group(3)
        if PROOF.search(body) and VERB.match(body.strip()):
            tid = m.group(2)
            lines[i] = '- [x] ' + tid + body + ' (deferred to the final checkpoint: runtime proof; see specs/deferred-checks.md)'
            done.append(tid)
    if not done:
        return []
    open(tasks, 'w', encoding='utf-8').write('\n'.join(lines))
    try:
        have = open(checks, encoding='utf-8').read()
    except FileNotFoundError:
        have = ''
    add = ''.join(f'{cap} {t}: runtime proof, run once at the final checkpoint (commands in the task text of {tasks}).\n' for t in done if f'{cap} {t}:' not in have)
    if add:
        open(checks, 'a', encoding='utf-8').write(('' if have.endswith('\n') or not have else '\n') + add)
    return done


if __name__ == '__main__':
    r = main(*sys.argv[1:4])
    print(' '.join(r))
