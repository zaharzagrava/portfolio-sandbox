#!/usr/bin/env python3
"""run_models.py: type-check and simulate the Quint models of the living specification.

  run_models.py [--samples N]

Each model page (docs/spec/models/*.md) with `format: quint` names its file and a `runs` list of `module:invariant:expected` (expected: pass or violation).
A run that ends differently from what the page says fails: a safety invariant that starts to fail is a bug, and a `violation` that disappears means the
documented gap was closed and the page must be updated. Needs Node; `npx` downloads Quint on first use.
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

QUINT = ['npx', '--yes', '@informalsystems/quint']


def run(cmd, timeout=300):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=common.ROOT)


def main(argv):
    samples = argv[argv.index('--samples') + 1] if '--samples' in argv else '3000'
    bad = checked = 0
    for page in common.pages('model'):
        if page['front'].get('format') != 'quint':
            continue
        qnt = page['front'].get('file', '')
        if not os.path.isfile(os.path.join(common.ROOT, qnt)):
            print(f'ERROR {page["rel"]}: file {qnt} not found')
            bad += 1
            continue
        t = run(QUINT + ['typecheck', qnt])
        if t.returncode != 0:
            print(f'ERROR {qnt}: does not type-check\n{(t.stdout + t.stderr)[-600:]}')
            bad += 1
            continue
        print(f'ok    {qnt}: type-checks')
        for spec in page['front'].get('runs', []):
            module, inv, expected = spec.split(':')
            r = run(QUINT + ['run', qnt, f'--main={module}', f'--invariant={inv}', '--max-steps=12', f'--max-samples={samples}'])
            outcome = 'violation' if r.returncode == 1 and '[violation]' in r.stdout else 'pass' if r.returncode == 0 else 'error'
            checked += 1
            if outcome == expected:
                print(f'ok    {module}/{inv}: {outcome} (as expected)')
            else:
                bad += 1
                print(f'ERROR {module}/{inv}: {outcome}, expected {expected}\n{(r.stdout + r.stderr)[-500:]}')
    print(f'-- {checked} model runs; {"FAILED" if bad else "all as expected"}')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
