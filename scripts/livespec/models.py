#!/usr/bin/env python3
"""models.py: the formal layer of the living specification.

  models.py check [--fix]     state-machine tables in docs/spec/models/*.md: well-formed, deterministic, total, every state reachable, terminal
                              states closed, and every state name present in the code file named by `code:`. --fix rewrites the Mermaid diagram block.

A model page holds a fenced block:

    ```statemachine
    initial: PENDING
    terminal: FAILED, REFUNDED
    states: PENDING, COMPLETED, FAILED, REFUNDED
    events: charge_succeeded, charge_failed, refund_done
    ignore: COMPLETED.charge_failed
    PENDING --charge_succeeded--> COMPLETED
    ```

Every pair of a non-terminal state and an event must be answered: a transition, or listed under `refused:` (the command is rejected as invalid),
`idempotent:` (a repeat of a move that already happened is a harmless no-op) or `ignore:` (anything else deliberately ignored). "What happens in this state for this
event?" always has an answer. Quint models (*.qnt) are run by run-models.sh.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

FENCE = re.compile(r'```statemachine\n(.*?)\n```', re.S)
EDGE = re.compile(r'^([A-Za-z0-9_]+)\s+--\s*([A-Za-z0-9_]+)\s*-->\s*([A-Za-z0-9_]+)\s*$')
DIAGRAM = re.compile(r'(<!-- diagram:start -->).*?(<!-- diagram:end -->)', re.S)


def parse_machine(text):
    m = FENCE.search(text)
    if not m:
        return None
    mc = {'initial': None, 'terminal': [], 'states': [], 'events': [], 'ignore': [], 'refused': [], 'idempotent': [], 'edges': [], 'bad_lines': []}
    for line in m.group(1).split('\n'):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        e = EDGE.match(line)
        if e:
            mc['edges'].append(e.groups())
            continue
        k, sep, v = line.partition(':')
        k = k.strip()
        if sep and k in ('initial', 'terminal', 'states', 'events', 'ignore', 'refused', 'idempotent'):
            vals = [x.strip() for x in v.split(',') if x.strip()]
            mc[k] = vals[0] if k == 'initial' and vals else (None if k == 'initial' else vals)
        else:
            mc['bad_lines'].append(line)
    return mc


def check_machine(mc, front=None):
    """-> list of (severity, message)."""
    out = []
    states, events = set(mc['states']), set(mc['events'])
    for line in mc['bad_lines']:
        out.append(('error', f'cannot read line: {line}'))
    if mc['initial'] not in states:
        out.append(('error', f'initial state {mc["initial"]!r} is not in states'))
    for t in mc['terminal']:
        if t not in states:
            out.append(('error', f'terminal state {t} is not in states'))
    seen = {}
    for s, ev, t in mc['edges']:
        for name, kind, pool in ((s, 'state', states), (t, 'state', states), (ev, 'event', events)):
            if name not in pool:
                out.append(('error', f'{kind} {name} used in "{s} --{ev}--> {t}" is not declared'))
        if (s, ev) in seen and seen[(s, ev)] != t:
            out.append(('error', f'not deterministic: {s} on {ev} goes to both {seen[(s, ev)]} and {t}'))
        seen[(s, ev)] = t
        if s in mc['terminal']:
            out.append(('error', f'terminal state {s} has an outgoing transition ({ev} to {t})'))
    ignore = set()
    for pair in mc['ignore'] + mc['refused'] + mc['idempotent']:
        s, _, ev = pair.partition('.')
        if s not in states or ev not in events:
            out.append(('error', f'entry {pair} names an undeclared state or event'))
        if (s, ev) in seen:
            out.append(('error', f'{pair} is listed as refused/idempotent/ignored and also has a transition'))
        ignore.add((s, ev))
    # reachability
    reach, todo = {mc['initial']}, [mc['initial']]
    while todo:
        cur = todo.pop()
        for s, ev, t in mc['edges']:
            if s == cur and t not in reach:
                reach.add(t)
                todo.append(t)
    for s in sorted(states - reach):
        out.append(('error', f'state {s} is not reachable from {mc["initial"]}'))
    # totality: every (non-terminal state, event) is answered
    for s in sorted(states - set(mc['terminal'])):
        for ev in sorted(events):
            if (s, ev) not in seen and (s, ev) not in ignore:
                out.append(('error', f'not total: nothing says what {ev} does in {s} (add a transition, or list {s}.{ev} under `refused:` or `idempotent:`)'))
    # the code
    ref = (front or {}).get('code', '')
    if ref:
        ok, why = common.code_ref_ok(ref.split('#')[0])
        if not ok:
            out.append(('error', f'code: {why}'))
        else:
            text = common.read(os.path.join(common.ROOT, ref.split('#')[0]), errors='ignore')
            for s in sorted(states):
                if not re.search(r'(?<![A-Za-z0-9_])%s(?![A-Za-z0-9_])' % re.escape(s), text):
                    out.append(('error', f'state {s} does not appear in {ref.split("#")[0]}'))
    else:
        out.append(('warn', 'no `code:` reference: the states are not checked against the code'))
    return out


def mermaid(mc):
    lines = ['```mermaid', 'stateDiagram-v2', f'    [*] --> {mc["initial"]}']
    for s, ev, t in mc['edges']:
        lines.append(f'    {s} --> {t}: {ev}')
    for t in mc['terminal']:
        lines.append(f'    {t} --> [*]')
    lines.append('```')
    return '\n'.join(lines)


def cmd_check(fix):
    bad = 0
    for page in common.pages('model'):
        mc = parse_machine(page['body'])
        if mc is None:
            continue   # a Quint/TLA+ model page: checked by run-models.sh
        problems = check_machine(mc, page['front'])
        for sev, msg in problems:
            print(f'{"ERROR" if sev == "error" else "warn "} {page["rel"]}: {msg}')
            bad += sev == 'error'
        if fix and DIAGRAM.search(page['text']):
            new = DIAGRAM.sub(lambda m: m.group(1) + '\n' + mermaid(mc) + '\n' + m.group(2), page['text'])
            if new != page['text']:
                open(page['path'], 'w', encoding='utf-8').write(new)
                print(f'diagram updated: {page["rel"]}')
        if not problems:
            print(f'ok    {page["rel"]}: {len(mc["states"])} states, {len(mc["edges"])} transitions, total')
    return 1 if bad else 0


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'check':
        sys.exit(cmd_check('--fix' in sys.argv))
    print(__doc__)
