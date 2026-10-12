#!/usr/bin/env python3
"""check.py [--root DIR] [--file lessons.md] [--today YYYY-MM-DD]: keeps docs/lessons.md honest.

- every `prevented` lesson must link at least one prevention, and every link must exist: backticked file paths (a bare file name is
  looked up anywhere in the repository) and commit hashes (checked with git; in a shallow clone a missing commit is only a warning);
- `open` lessons older than 14 days are listed (not a failure: they are the work list);
- a lesson in a class that already has one counts as a repeat (printed per class, not a failure: it is the number to watch);
- the index and the entries must agree (a structural problem is a failure too).
Exit 1 on a broken link or a structural problem."""
import argparse
import datetime
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

OPEN_DAYS = 14
TICK_RE = re.compile(r'`([^`\n]+)`')
PATH_RE = re.compile(r'^[\w@.+/-]+\.(?:ts|tsx|js|mjs|py|sh|md|json|yaml|yml|conf|tsv|sql|txt)$')
HASH_RE = re.compile(r'^[0-9a-f]{7,40}$')
SKIP_DIRS = {'.git', 'node_modules', '.moon', '.next', 'dist', '__pycache__'}


def repo_files(root):
    r = subprocess.run(['git', '-C', root, 'ls-files', '-c', '-o', '--exclude-standard'], capture_output=True, text=True)
    if r.returncode == 0 and r.stdout.strip():
        return [p for p in r.stdout.split('\n') if p]
    out = []
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
        out += [os.path.relpath(os.path.join(d, f), root) for f in files]
    return out


def is_git(root):
    return subprocess.run(['git', '-C', root, 'rev-parse', '--git-dir'], capture_output=True).returncode == 0


def is_shallow(root):
    r = subprocess.run(['git', '-C', root, 'rev-parse', '--is-shallow-repository'], capture_output=True, text=True)
    return r.stdout.strip() == 'true'


def links_of(les):
    """The checkable references in the prevention text: ('path', token) and ('commit', token)."""
    out, seen = [], set()
    for tok in TICK_RE.findall(les.prevention_text):
        tok = tok.strip().split('#')[0]
        if tok in seen:
            continue
        seen.add(tok)
        if HASH_RE.match(tok) and re.search(r'\d', tok):
            out.append(('commit', tok))
        elif PATH_RE.match(tok):
            out.append(('path', tok))
    return out


def check(lessons, problems, root, today):
    """Returns (broken lines, warning lines, open-old lines, repeat lines, ok count)."""
    files = set(repo_files(root))
    names = {}
    for f in files:
        names.setdefault(os.path.basename(f), []).append(f)
    git, shallow = is_git(root), None
    broken, warns, ok = list(problems), [], 0
    for les in lessons:
        if les.status != 'prevented':
            continue
        links = links_of(les)
        if not links:
            broken.append(f'{les.id} is "prevented" but links no prevention (a backticked file path or commit hash after **Prevention:**)')
            continue
        for kind, tok in links:
            if kind == 'path':
                found = tok in files or os.path.exists(os.path.join(root, tok)) if '/' in tok else tok in names
                if found:
                    ok += 1
                else:
                    broken.append(f'{les.id}: the prevention `{tok}` does not exist')
            else:
                if not git:
                    warns.append(f'{les.id}: commit `{tok}` not checked (not a git repository)')
                    continue
                exists = subprocess.run(['git', '-C', root, 'cat-file', '-e', tok + '^{commit}'], capture_output=True).returncode == 0
                if exists:
                    ok += 1
                else:
                    if shallow is None:
                        shallow = is_shallow(root)
                    (warns if shallow else broken).append(f'{les.id}: commit `{tok}` {"not in this shallow clone" if shallow else "does not exist"}')
    old = []
    for les in lessons:
        if les.status == 'open':
            try:
                age = (today - datetime.date.fromisoformat(les.date)).days
            except ValueError:
                broken.append(f'{les.id} has a bad date "{les.date}"')
                continue
            if age > OPEN_DAYS:
                old.append(f'{les.id} ({les.cls}, {age} days): {les.title}')
    rep = [f'{c}: {len(ids)} ({", ".join(ids)})' for c, ids in sorted(common.repeats(lessons).items())]
    return broken, warns, old, rep, ok


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=common.ROOT)
    ap.add_argument('--file', default=None, help='default: <root>/docs/lessons.md')
    ap.add_argument('--today', default=None)
    a = ap.parse_args(argv)
    path = a.file or os.path.join(a.root, 'docs', 'lessons.md')
    today = datetime.date.fromisoformat(a.today) if a.today else datetime.date.today()
    if not os.path.exists(path):
        print(f'lessons: {path} not found', file=sys.stderr)
        return 1
    lessons, problems = common.load(path)
    broken, warns, old, rep, ok = check(lessons, problems, a.root, today)
    prevented = sum(1 for x in lessons if x.status == 'prevented')
    print(f'{len(lessons)} lessons, {prevented} prevented ({ok} links checked), {len(lessons) - prevented} open')
    for w in warns:
        print(f'warning: {w}')
    if old:
        print(f'open for more than {OPEN_DAYS} days:')
        for o in old:
            print(f'  {o}')
    print('repeats (a lesson in a class that already had one): ' + ('; '.join(rep) if rep else 'none'))
    for b in broken:
        print(f'BROKEN: {b}')
    return 1 if broken else 0


if __name__ == '__main__':
    sys.exit(main())
