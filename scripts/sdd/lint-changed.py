#!/usr/bin/env python3
"""lint-changed.py <eslint-json>: fail only for ESLint errors on lines this capability added or changed.

The gate runs `eslint --fix --format json` over the files the capability touched (so formatting is fixed first). Old
errors on lines the capability did not touch are debt of an earlier time and do not fail it; new files count in full.
Parse errors always fail. Usage: lint-changed.py <eslint.json>
"""
import json, os, re, subprocess, sys

HUNK = re.compile(r'^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@')


def repo_root():
    return subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True, check=True).stdout.strip()


def changed_ranges(rel):
    """None = whole file (untracked); else a list of (first, last) new-side line ranges of the diff against HEAD."""
    if subprocess.run(['git', 'ls-files', '--error-unmatch', rel], capture_output=True).returncode != 0:
        return None
    diff = subprocess.run(['git', 'diff', '-U0', 'HEAD', '--', rel], capture_output=True, text=True).stdout
    out = []
    for line in diff.splitlines():
        m = HUNK.match(line)
        if m:
            start, count = int(m.group(1)), int(m.group(2) if m.group(2) is not None else 1)
            out.append((start, start + max(count, 1) - 1))
    return out


def main():
    try:
        results = json.load(open(sys.argv[1]))
    except Exception as e:  # no output file or invalid JSON: eslint itself crashed
        print('eslint produced no usable report:', e)
        return 1
    root = repo_root()
    bad, old = [], 0
    for r in results:
        errs = [m for m in r.get('messages', []) if m.get('severity') == 2]
        if not errs:
            continue
        rel = os.path.relpath(r['filePath'], root)
        ranges = changed_ranges(rel)
        for m in errs:
            line = m.get('line') or 0
            if m.get('fatal') or ranges is None or any(a <= line <= b for a, b in ranges):
                bad.append('%s:%s  %s  %s' % (rel, line, m.get('ruleId') or 'parse', m.get('message', '')[:140]))
            else:
                old += 1
    if bad:
        print('ESLint errors on lines this capability added or changed:')
        print('\n'.join(bad))
        return 1
    if old:
        print('(%d older ESLint error(s) on untouched lines ignored)' % old)
    return 0


sys.exit(main())
