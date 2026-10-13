#!/usr/bin/env python3
"""How many defects has the QA agent found?   scripts/qa/tally.py            counts per charter and verdict
                                               scripts/qa/tally.py set <stamp> <charter> <id> <verdict>      record a person's verdict
Verdicts: pending (not looked at), real (a defect), gap (reported something not built yet), false (not a defect), noise (dev-server noise), dup (the same defect as an earlier row: not counted).
                                               scripts/qa/tally.py known      the earlier findings that are settled (gap, false, noise, and real ones that have a test in packages/web/tests/qa), one per line
Precision = real / (real + false + noise + gap), over the findings a person has judged. The benchmark (scripts/qa/benchmark.sh) measures recall on known defects."""
import collections, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'findings.tsv')
VERDICTS = ('pending', 'real', 'gap', 'false', 'noise', 'dup')
rows = [l.rstrip('\n').split('\t') for l in open(P) if l.strip() and not l.startswith('#')]
if sys.argv[1:2] == ['known']:
    import glob
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    for r in rows:
        stamp, charter, did, kind, sev, verdict, title = (r + [''] * 7)[:7]
        if verdict in ('gap', 'false', 'noise') or (verdict == 'real' and glob.glob(f'{root}/packages/web/tests/qa/{charter}-*{did}.spec.ts') and (glob.glob(f'{root}/packages/web/tests/qa/{charter}-{stamp}-{did}.spec.ts') or os.path.exists(f'{root}/packages/web/tests/qa/{charter}-{did}.spec.ts'))):
            print('\t'.join([stamp, charter, did, verdict, title]))
    sys.exit(0)
if sys.argv[1:2] == ['set']:
    stamp, charter, did, verdict = sys.argv[2:6]
    assert verdict in VERDICTS, VERDICTS
    hit = 0
    lines = open(P).read().split('\n')
    for i, l in enumerate(lines):
        f = l.split('\t')
        if len(f) > 5 and f[:3] == [stamp, charter, did]:
            f[5] = verdict; lines[i] = '\t'.join(f); hit += 1
    open(P, 'w').write('\n'.join(lines)); print(f'{hit} finding(s) set to {verdict}'); sys.exit(0 if hit else 1)
by = collections.defaultdict(collections.Counter)
for r in rows: by[r[1]][r[5]] += 1
tot = collections.Counter()
for c, cnt in sorted(by.items()):
    print(f'{c:10} ' + ', '.join(f'{k} {cnt[k]}' for k in VERDICTS if cnt[k])); tot.update(cnt)
judged = sum(v for k, v in tot.items() if k not in ('pending', 'dup'))
print(f'total {sum(tot.values())} findings: ' + ', '.join(f'{k} {tot[k]}' for k in VERDICTS if tot[k]))
if judged: print(f'precision on the {judged} judged: {tot["real"] / judged:.0%} real')
