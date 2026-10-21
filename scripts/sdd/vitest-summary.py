#!/usr/bin/env python3
"""vitest-summary.py <vitest json report> [base dir]: prints the result of one Vitest run in the words Jest used.

The loop's readers (sweep-verdict.py, failures.py, test-spec.sh, the checkpoint) were written for Jest's log: a line `PASS <path>` or
`FAIL <path>` per file, `  ● <suite> › <test>` blocks with the message of each failing test, and the summary lines `Test Suites: ...`
and `Tests: ...`. Printing the same lines from Vitest's JSON report keeps all of them working. Paths are relative to the base dir
(default: the current directory, packages/backend). A report that does not exist (the process died) prints nothing, so the missing
`Test Suites:` line is how a crashed batch is noticed, as before.
"""
import json, os, sys


def main(report, base):
    try:
        data = json.load(open(report))
    except Exception:
        return 1
    files = data.get('testResults', [])
    out, failed_files = [], 0
    for f in files:
        name = os.path.relpath(f.get('name', '?'), base)
        asserts = f.get('assertionResults', [])
        bad = [a for a in asserts if a.get('status') == 'failed']
        if f.get('status') == 'failed' or bad:
            failed_files += 1
            out.append(f'FAIL {name}')
            if not bad:   # the file did not even start (import error, setup error)
                out.append('  ● Test suite failed to run')
                out.append('')
                out.extend('    ' + l for l in (f.get('message') or 'no message').splitlines()[:40])
                out.append('')
            for a in bad:
                title = ' › '.join(a.get('ancestorTitles', []) + [a.get('title', '')])
                out.append(f'  ● {title}')
                out.append('')
                out.extend('    ' + l for l in '\n'.join(a.get('failureMessages') or ['no message']).splitlines()[:40])
                out.append('')
        else:
            out.append(f'PASS {name}')
    total, passed = len(files), len(files) - failed_files
    tp, tf, tt = data.get('numPassedTests', 0), data.get('numFailedTests', 0), data.get('numTotalTests', 0)
    skipped = data.get('numPendingTests', 0) + data.get('numTodoTests', 0)
    parts = ([f'{failed_files} failed'] if failed_files else []) + ([f'{passed} passed'] if passed else [])
    tparts = ([f'{tf} failed'] if tf else []) + ([f'{skipped} skipped'] if skipped else []) + ([f'{tp} passed'] if tp else [])
    out.append('Test Suites: ' + ', '.join(parts or ['0 passed']) + f', {total} total')
    out.append('Tests:       ' + ', '.join(tparts or ['0 passed']) + f', {tt} total')
    print('\n'.join(out))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else os.getcwd()))
