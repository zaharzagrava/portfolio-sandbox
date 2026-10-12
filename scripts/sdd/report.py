#!/usr/bin/env python3
"""report.py [--input .sdd-metrics/steps.jsonl] [--out-dir docs/reports] [--date YYYY-MM-DD] [--stdout]

Turns the loop's step log into docs/reports/<date>.md: per capability the implement passes, repairs, gate failures, flakes (a gate that
passed after repairs that changed no code), checkpoint failures, interventions and elapsed time; per checkpoint the same; and the trend over runs.
Input: one JSON object per line (written by metric_step in scripts/sdd/lib.sh and by scripts/sdd/note-intervention.sh):
  run, capability, step, start, end, seconds, result, attempt, reason, and optionally flake (true) and code_changed (true/false).
Steps: plan tasks analyze implement-N converge-N gate repair-N doctor-N built blocked intervention run-start; for a checkpoint the
capability is "checkpoint:<label>" and the steps are checkpoint and ckrepair-<label>-N.
Lists only, no tables."""
import argparse
import datetime
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
NOT_WORK = {'built', 'blocked', 'intervention', 'run-start'}


def load(path):
    events, bad = [], 0
    if not os.path.exists(path):
        return events, 0
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                bad += 1
                continue
            if not isinstance(e, dict) or 'step' not in e or 'capability' not in e:
                bad += 1
                continue
            e.setdefault('run', '?')
            e['seconds'] = e.get('seconds') if isinstance(e.get('seconds'), (int, float)) else 0
            e['attempt'] = e.get('attempt') if isinstance(e.get('attempt'), int) else 0
            events.append(e)
    return events, bad


def new_cap():
    return dict(implement=0, converge=0, gate_pass=0, gate_fail=0, repairs=0, repairs_no_code=0, doctor=0, flakes=0, flake_runs=[],
                built=False, blocked=False, blocked_why='', interventions=0, hand=0, seconds=0, usage_limits=0, runs=set(), fail_reasons=[],
                ck_fail=0, ck_pass=0)


def analyse(events):
    """Returns (caps, checkpoints, interventions, runs). Everything is derived from the event order within a run and capability."""
    caps, cks, interventions, runs = {}, {}, [], {}
    pending = {}  # (run, cap) -> list of code_changed flags of repair steps since the first failed gate
    for e in events:
        cap, step, run = e['capability'], e['step'], e['run']
        r = runs.setdefault(run, dict(start=e.get('start', ''), built=0, implement=0, repairs=0, ck_repairs=0, gate_fail=0, flakes=0, ck_fail=0, interventions=0,
                                       seconds=0, settings='', events=0))
        r['events'] += 1
        if e.get('start') and (not r['start'] or e['start'] < r['start']):
            r['start'] = e['start']
        if step == 'run-start':
            r['settings'] = e.get('reason', '')
            continue
        if step == 'intervention':
            interventions.append(dict(date=(e.get('start') or '')[:10], cap=cap, text=e.get('reason', '')))
            r['interventions'] += 1
            if cap != '-' and not cap.startswith('checkpoint:'):
                c = caps.setdefault(cap, new_cap())
                c['interventions'] += 1
                c['hand'] += 1 if e.get('reason', '').lower().startswith('found by hand') else 0
            continue
        is_ck = cap.startswith('checkpoint:')
        if is_ck:
            c = cks.setdefault(cap.split(':', 1)[1], dict(fail=0, passed=0, repairs=0, repairs_no_code=0, flakes=0, seconds=0, reasons=[], runs=set()))
            c['runs'].add(run)
            c['seconds'] += e['seconds']
            r['seconds'] += e['seconds']
            if step == 'checkpoint':
                if e.get('result') == 'pass':
                    c['passed'] += 1
                    if e.get('flake'):
                        c['flakes'] += 1
                        r['flakes'] += 1
                else:
                    c['fail'] += 1
                    r['ck_fail'] += 1
                    if e.get('reason'):
                        c['reasons'].append(e['reason'])
            elif step.startswith('ckrepair-'):
                c['repairs'] += 1
                r['ck_repairs'] += 1
                if e.get('code_changed') is False:
                    c['repairs_no_code'] += 1
            continue
        if cap == '-':
            continue
        c = caps.setdefault(cap, new_cap())
        c['runs'].add(run)
        if step == 'built':
            c['built'] = True
            r['built'] += 1
            continue
        if step == 'blocked':
            c['blocked'], c['blocked_why'] = True, e.get('reason', '')
            continue
        c['seconds'] += e['seconds']
        r['seconds'] += e['seconds']
        if e.get('reason') == 'usage-limit':
            c['usage_limits'] += 1
        key = (run, cap)
        if re.match(r'implement-\d+$', step):
            c['implement'] += 1
            r['implement'] += 1
        elif re.match(r'converge-\d+$', step):
            c['converge'] += 1
        elif re.match(r'(repair|doctor)-\d+$', step):
            c['repairs'] += 1
            r['repairs'] += 1
            if step.startswith('doctor'):
                c['doctor'] += 1
            if e.get('code_changed') is False:
                c['repairs_no_code'] += 1
            if key in pending:
                pending[key].append(e.get('code_changed'))
        elif step == 'gate':
            if e.get('result') == 'pass':
                c['gate_pass'] += 1
                flake = bool(e.get('flake'))
                if 'flake' not in e and e['attempt'] > 1 and pending.get(key) and all(x is False for x in pending[key]):
                    flake = True  # derived: repairs ran, none changed code
                if flake:
                    c['flakes'] += 1
                    r['flakes'] += 1
                    c['flake_runs'].append(run)
                pending.pop(key, None)
            else:
                c['gate_fail'] += 1
                r['gate_fail'] += 1
                if e.get('reason'):
                    c['fail_reasons'].append(e['reason'])
                pending.setdefault(key, [])
    return caps, cks, interventions, runs


def dur(s):
    s = int(round(s))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    if h:
        return f'{h}h {m:02d}m'
    if m:
        return f'{m}m {sec:02d}s' if m < 10 else f'{m}m'
    return f'{sec}s'


def ratio(a, b):
    return a / b if b else 0.0


def trend_lines(runs):
    order = sorted(runs.items(), key=lambda kv: (kv[1]['start'], kv[0]))
    out = []
    for run, r in order:
        out.append(f'- run {run} ({r["start"][:16].replace("T", " ")}): {r["built"]} built, {r["implement"]} implement passes, {r["repairs"]} repairs, '
                   f'{r["gate_fail"]} gate failures, {r["flakes"]} flakes, {r["ck_fail"]} checkpoint failures ({r["ck_repairs"]} checkpoint repairs), {r["interventions"]} interventions, '
                   f'{dur(r["seconds"])} of steps')
        if r['settings']:
            out.append(f'  - settings: {r["settings"]}')
    if len(order) >= 2:
        (pa, a), (pb, b) = order[-2], order[-1]
        out.append('')
        out.append(f'Latest run {pb} against the one before ({pa}), per capability built (or per run when nothing was built):')
        for label, key in (('repairs', 'repairs'), ('gate failures', 'gate_fail'), ('flakes', 'flakes'), ('implement passes', 'implement')):
            va, vb = ratio(a[key], a['built'] or 1), ratio(b[key], b['built'] or 1)
            word = 'same' if abs(va - vb) < 0.05 else ('up' if vb > va else 'down')
            out.append(f'- {label}: {vb:.1f} (before {va:.1f}), {word}')
        sa = dict(re.findall(r'(\w+)=(\S+)', a['settings']))
        sb = dict(re.findall(r'(\w+)=(\S+)', b['settings']))
        changed = [f'{k} {sa.get(k, "-")} -> {sb.get(k, "-")}' for k in sorted(set(sa) | set(sb)) if sa.get(k) != sb.get(k) and k != 'commit']
        out.append('- settings changed since the previous run: ' + (', '.join(changed) if changed else 'none'))
    return out


def render(events, bad=0, source='.sdd-metrics/steps.jsonl', date=None):
    caps, cks, interventions, runs = analyse(events)
    date = date or datetime.date.today().isoformat()
    starts = sorted(e.get('start', '') for e in events if e.get('start'))
    ends = sorted(e.get('end', '') for e in events if e.get('end'))
    L = [f'# Build loop report {date}', '']
    L.append(f'Source: `{source}`, {len(events)} step lines{f" ({bad} unreadable lines skipped)" if bad else ""}, '
             f'{len(runs)} run{"s" if len(runs) != 1 else ""}' + (f', {starts[0][:16].replace("T", " ")} to {ends[-1][:16].replace("T", " ")} UTC.' if starts and ends else '.'))
    L += ['Words: a pass is one fresh-context implement call; a repair is one repair-agent call (gate repair or doctor); a flake is a gate (or checkpoint) that',
          'passed after repairs that changed no code, so the repair was not what fixed it.', '']
    work = caps
    L.append('## Totals')
    built = sum(1 for v in work.values() if v['built'])
    L.append(f'- capabilities built: {built} of {len(work)} seen; blocked: {sum(1 for v in work.values() if v["blocked"] and not v["built"])}')
    L.append(f'- implement passes: {sum(v["implement"] for v in work.values())}; repairs: {sum(v["repairs"] for v in work.values())} '
             f'(of which changed no code: {sum(v["repairs_no_code"] for v in work.values())})')
    L.append(f'- gate attempts: {sum(v["gate_pass"] for v in work.values())} passed, {sum(v["gate_fail"] for v in work.values())} failed; '
             f'flakes: {sum(v["flakes"] for v in work.values())}')
    L.append(f'- checkpoint attempts: {sum(v["passed"] for v in cks.values())} passed, {sum(v["fail"] for v in cks.values())} failed; '
             f'interventions: {len(interventions)} (found by hand: {sum(1 for i in interventions if i["text"].lower().startswith("found by hand"))})')
    L.append(f'- elapsed in steps: {dur(sum(v["seconds"] for v in work.values()) + sum(v["seconds"] for v in cks.values()))}; '
             f'usage-limit stops: {sum(v["usage_limits"] for v in work.values())}')
    L.append('')
    L.append('## Per capability')
    if not work:
        L.append('- no capability steps recorded yet')
    for cap in sorted(work):
        v = work[cap]
        state = 'built' if v['built'] else ('blocked: ' + v['blocked_why'] if v['blocked'] else 'not finished')
        L.append(f'### {cap}')
        L.append(f'- state: {state}; runs: {len(v["runs"])}; elapsed {dur(v["seconds"])}')
        L.append(f'- implement passes: {v["implement"]}; converge passes: {v["converge"]}')
        L.append(f'- repairs: {v["repairs"]} (doctor {v["doctor"]}, changed no code {v["repairs_no_code"]})')
        L.append(f'- gate: {v["gate_pass"]} passed, {v["gate_fail"]} failed' + (f'; first reasons: {"; ".join(v["fail_reasons"][:3])}' if v['fail_reasons'] else ''))
        L.append(f'- flakes: {v["flakes"]}')
        L.append(f'- interventions: {v["interventions"]} (found by hand: {v["hand"]})')
        if v['usage_limits']:
            L.append(f'- usage-limit stops: {v["usage_limits"]}')
    L.append('')
    L.append('## Checkpoints')
    if not cks:
        L.append('- no checkpoint recorded yet')
    for label in sorted(cks):
        v = cks[label]
        L.append(f'- {label}: {v["passed"]} passed, {v["fail"]} failed; repairs {v["repairs"]} (changed no code {v["repairs_no_code"]}); flakes {v["flakes"]}; '
                 f'elapsed {dur(v["seconds"])}' + (f'; failures began with: {"; ".join(v["reasons"][:3])}' if v['reasons'] else ''))
    L.append('')
    L.append('## Interventions')
    if not interventions:
        L.append('- none recorded (`scripts/sdd/note-intervention.sh "text" [capability]`)')
    for i in interventions:
        L.append(f'- {i["date"]} {i["cap"]}: {i["text"]}')
    L.append('')
    L.append('## Trend over runs')
    L += trend_lines(runs) or ['- no run recorded yet']
    L.append('')
    return '\n'.join(L)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', default=os.path.join(ROOT, '.sdd-metrics', 'steps.jsonl'))
    ap.add_argument('--out-dir', default=os.path.join(ROOT, 'docs', 'reports'))
    ap.add_argument('--date', default=None)
    ap.add_argument('--stdout', action='store_true')
    a = ap.parse_args(argv)
    events, bad = load(a.input)
    if not events and not os.path.exists(a.input):
        print(f'no metrics yet: {a.input} does not exist (the loop writes it; see scripts/sdd/note-intervention.sh)', file=sys.stderr)
        return 1
    date = a.date or datetime.date.today().isoformat()
    text = render(events, bad, os.path.relpath(a.input, ROOT) if a.input.startswith(ROOT) else a.input, date)
    if a.stdout:
        print(text)
        return 0
    os.makedirs(a.out_dir, exist_ok=True)
    out = os.path.join(a.out_dir, f'{date}.md')
    with open(out, 'w', encoding='utf-8') as f:
        f.write(text)
    print(out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
