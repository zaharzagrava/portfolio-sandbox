#!/usr/bin/env python3
"""Import codemod (Phase 2+): rewrites every import whose source file or target file moves.

Same algorithm as phase1_rewrite_imports.py, but resolves the post-Phase-1 aliases
(`@app/{infrastructure,composition,domains}/*`, `@app/common/*` with its legacy fallback).

Runs against the OLD layout (before `git mv`). For each import in each TS file, it:
1. resolves the specifier to a file in the old layout (relative, `@app/common/*`, `@app/<app>/*`);
2. maps the importing file and the target to their new locations (<moves.tsv>);
3. if either moves, emits a new specifier: a relative path when both sit in the same lib,
   otherwise the area alias (`@app/{infrastructure,common,composition,domains}/*`).
Imports where neither side moves are left byte-for-byte unchanged.

Usage: rewrite_imports.py <backend_root> <moves.tsv> [--dry-run]
"""
import os
import re
import sys

ROOT = os.path.abspath(sys.argv[1])
MOVES_FILE = sys.argv[2]
DRY = '--dry-run' in sys.argv
LEGACY = os.path.join(ROOT, 'libs/common/src')
LIBS = os.path.join(ROOT, 'libs')
APP_ALIASES = {'core', 'bff', 'sse-gateway', 'worker', 'projector', 'collab', 'public-api', 'payment-processor'}

moves = []
for line in open(MOVES_FILE):
    line = line.rstrip('\n')
    if not line or line.startswith('#'):
        continue
    src, dst = line.split('\t')
    moves.append((os.path.normpath(os.path.join(LEGACY, src)), os.path.normpath(os.path.join(LIBS, dst))))  # either may leave libs/common/src (../)
moves.sort(key=lambda m: -len(m[0]))  # longest prefix first: file rules beat their directory


def new_path(old):
    for src, dst in moves:
        if old == src or old.startswith(src + os.sep):
            return dst + old[len(src):]
    return old


def unit(path):
    """The lib a file belongs to: imports inside one unit stay relative."""
    rel = os.path.relpath(path, ROOT).split(os.sep)
    if rel[0] == 'libs' and len(rel) > 2:
        if rel[1] == 'common' and rel[2] == 'src':
            return ('legacy', rel[3] if len(rel) > 4 else '<root>')
        return (rel[1], rel[2])
    if rel[0] == 'apps':
        return ('apps', rel[1])
    return ('other', rel[0])


def candidates(base):
    return ((base + '.ts', False), (base + '.tsx', False), (base, False), (os.path.join(base, 'index.ts'), True))


def resolve(spec, from_file):
    bases = []
    if spec.startswith('.'):
        bases = [os.path.normpath(os.path.join(os.path.dirname(from_file), spec))]
    elif spec == '@app/common':
        bases = [LEGACY]
    elif spec.startswith('@app/common/'):
        rest = spec[len('@app/common/'):]
        bases = [os.path.join(LIBS, 'common', rest), os.path.join(LEGACY, rest)]  # tsconfig fallback order
    elif spec.startswith('@app/test/'):
        bases = [os.path.join(ROOT, 'test', spec[len('@app/test/'):])]
    elif re.match(r'@app/(infrastructure|composition|domains)(/|$)', spec):
        area, _, rest = spec[len('@app/'):].partition('/')
        bases = [os.path.join(LIBS, area, rest)]
    elif spec.startswith('@app/') and spec.split('/')[1] in APP_ALIASES:
        app, rest = spec.split('/', 2)[1], spec.split('/', 2)[2]
        bases = [os.path.join(ROOT, 'apps', app, 'src', rest)]
    for base in bases:
        for cand, via_index in candidates(base):
            if os.path.isfile(cand):
                return cand, via_index
    return None


def strip_ext(p):
    return re.sub(r'\.tsx?$', '', p)


def specifier(from_new, target_new, via_index):
    target = os.path.dirname(target_new) if via_index else strip_ext(target_new)
    if unit(from_new) == unit(target_new):
        rel = os.path.relpath(target, os.path.dirname(from_new))
        return rel if rel.startswith('.') else './' + rel
    rel = os.path.relpath(target, ROOT).split(os.sep)
    if rel[:3] == ['libs', 'common', 'src']:
        return '/'.join(['@app/common'] + rel[3:]) if len(rel) > 3 else '@app/common'
    if rel[0] == 'libs' and rel[1] in ('infrastructure', 'common', 'composition', 'domains'):
        return '/'.join(['@app/' + rel[1]] + rel[2:])
    if rel[0] == 'test' and len(rel) > 1:
        return '/'.join(['@app/test'] + rel[1:])
    if rel[0] == 'apps' and rel[1] in APP_ALIASES and len(rel) > 3 and rel[2] == 'src':
        return '/'.join(['@app/' + rel[1]] + rel[3:])
    out = os.path.relpath(target, os.path.dirname(from_new))
    return out if out.startswith('.') else './' + out


SPEC_RE = re.compile(r"""((?:\bfrom|\bimport|\bdeclare\s+module|\brequire\s*\(|\bimport\s*\(|jest\.(?:mock|requireActual|doMock)\s*\()\s*)(['"])([^'"\n]+)\2""")

changed_files = 0
changed_specs = 0
unresolved_moved = []
for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames[:] = [d for d in dirnames if d not in ('node_modules', 'dist', '.git')]
    for name in filenames:
        if not re.search(r'\.(ts|tsx|mts)$', name) or name.endswith('.d.ts'):
            continue
        f_old = os.path.join(dirpath, name)
        f_new = new_path(f_old)
        text = open(f_old, encoding='utf-8').read()

        def sub(m):
            global changed_specs
            spec = m.group(3)
            hit = resolve(spec, f_old)
            if hit is None:
                if f_old != f_new and spec.startswith('.'):
                    unresolved_moved.append(f'{os.path.relpath(f_old, ROOT)}: {spec}')
                return m.group(0)
            t_old, via_index = hit
            t_new = new_path(t_old)
            if t_old == t_new and f_old == f_new:
                return m.group(0)
            new_spec = specifier(f_new, t_new, via_index)
            if new_spec == spec:
                return m.group(0)
            changed_specs += 1
            return f'{m.group(1)}{m.group(2)}{new_spec}{m.group(2)}'

        out = SPEC_RE.sub(sub, text)
        if out != text:
            changed_files += 1
            if not DRY:
                open(f_old, 'w', encoding='utf-8').write(out)

print(f'{"[dry-run] " if DRY else ""}rewrote {changed_specs} import specifiers in {changed_files} files')
if unresolved_moved:
    print('WARNING: unresolved relative imports in moved files:')
    print('\n'.join('  ' + u for u in unresolved_moved))
    sys.exit(1)
