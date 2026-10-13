#!/usr/bin/env python3
"""humans_links.py: link the generated map (docs/humans) to the living specification (docs/spec), which is the source of truth.

  humans_links.py [--check]

Every unit page of docs/humans has a `root:` (the code folder it describes). A capability of docs/spec covers it when one of the capability's `scope:` folders contains the
root, or lies inside it. The script writes a computed block "Specification" into the unit page (idempotent; it must run after `pnpm docs:generate`, which rewrites the pages, and
the docs:generate script runs it). The direction is one way on purpose: the spec never links to the generated map (render wipes it), the map points at the spec.
--check exits 1 when a unit page is missing its block or has a stale one.
"""
import glob
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

BLOCK = re.compile(r'<!-- spec-links:start -->.*?<!-- spec-links:end -->\n?', re.S)


def covers(root, scope):
    s = scope.split('*')[0].rstrip('/')
    return bool(s) and (root == s or root.startswith(s + '/') or s.startswith(root + '/'))


def main(argv):
    caps = common.pages('capability')
    stale = 0
    for path in sorted(glob.glob(os.path.join(common.ROOT, 'docs', 'humans', 'units', '**', '*.md'), recursive=True)):
        text = open(path, encoding='utf-8').read()
        front, body = common.parse_front(text)
        root = (front.get('root') or '').strip('"')
        if not root:
            continue
        hits = [c for c in caps if any(covers(root, sc) for sc in c['front'].get('scope', []))]
        if not hits:
            continue
        rel = lambda c: os.path.relpath(c['path'], os.path.dirname(path))   # noqa: E731
        lines = ['<!-- spec-links:start -->', '## Specification', '',
                 'The living specification is the source of truth for what this unit does; this page is generated from the code and may lag behind it.', '']
        lines += [f'- [{c["front"]["id"]} {c["front"].get("title", "")[:80]}]({rel(c)})' for c in hits]
        lines += ['<!-- spec-links:end -->', '']
        block = '\n'.join(lines)
        new = BLOCK.sub(lambda m: block, text) if BLOCK.search(text) else text.rstrip('\n') + '\n\n' + block
        if new != text:
            stale += 1
            if '--check' not in argv:
                open(path, 'w', encoding='utf-8').write(new)
    print(f'{stale} unit page(s) {"need" if "--check" in argv else "got"} a Specification block')
    return 1 if stale and '--check' in argv else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
