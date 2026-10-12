#!/usr/bin/env python3
"""sign.py: human sign-off on living-specification pages.

  sign.py status                    which pages are signed, and which signed items changed since
  sign.py sign <id|slug> [--reviewer NAME] [--only S13.R-01,S13.B-02]
                                    store the hash of every rule, behavior and concept item you have read (human action; agents have no permission to run it)
  sign.py diff <id|slug>            git diff of the page since the commit it was signed at

A sign-off is `<page>.reviewed.json` next to the page: {items: {id: hash}, reviewer, reviewed_at, signed_commit}. The hash covers an item's normalised text, so
whitespace-only edits do not count. Signing also sets `status: reviewed` in the page's front matter (the only thing this tool writes in a page).
"""
import json
import os
import re
import subprocess
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402


def signoff_path(page):
    return page['path'][:-3] + '.reviewed.json'


def load_signoff(page):
    p = signoff_path(page)
    if not os.path.exists(p):
        return None
    with open(p) as f:
        return json.load(f)


def compare(page):
    """-> None if never signed, else {'changed': [...], 'removed': [...], 'unreviewed': [...], 'signed': [...]}."""
    so = load_signoff(page)
    if not so:
        return None
    cur = {it['id']: it['hash'] for it in page['items']}
    signed = so.get('items', {})
    return {
        'changed': sorted(k for k, v in signed.items() if k in cur and cur[k] != v),
        'removed': sorted(k for k in signed if k not in cur),
        'unreviewed': sorted(k for k in cur if k not in signed),
        'signed': sorted(k for k, v in signed.items() if cur.get(k) == v),
    }


def find_page(key):
    for kind in ('capability', 'concept'):
        for p in common.pages(kind):
            if key in (p['front'].get('id'), common.slug_of(p)):
                return p
    return None


def git(*args):
    return subprocess.run(['git', '-C', common.ROOT, *args], capture_output=True, text=True).stdout.strip()


def cmd_status():
    total = signed = 0
    for kind in ('capability', 'concept'):
        for p in common.pages(kind):
            c = compare(p)
            n = len(p['items'])
            total += n
            if c is None:
                print(f'{p["rel"]}: not signed ({n} items)')
                continue
            signed += len(c['signed'])
            extra = ''
            if c['changed']:
                extra += f'; CHANGED since sign-off: {" ".join(c["changed"][:6])}'
            if c['removed']:
                extra += f'; REMOVED: {" ".join(c["removed"][:6])}'
            if c['unreviewed']:
                extra += f'; {len(c["unreviewed"])} new, unreviewed'
            so = load_signoff(p)
            print(f'{p["rel"]}: {len(c["signed"])}/{n} signed by {so["reviewer"]} on {so["reviewed_at"]}{extra}')
    print(f'-- {signed}/{total} items signed and unchanged')
    return 0


def cmd_sign(key, reviewer, only):
    page = find_page(key)
    if not page:
        print(f'no page for {key}', file=sys.stderr)
        return 2
    items = {it['id']: it['hash'] for it in page['items']}
    if only:
        missing = [o for o in only if o not in items]
        if missing:
            print(f'not in the page: {" ".join(missing)}', file=sys.stderr)
            return 2
        items = {k: v for k, v in items.items() if k in only}
    so = load_signoff(page) or {'items': {}}
    so['items'].update(items)
    so['items'] = dict(sorted(so['items'].items()))
    so.update({'reviewer': reviewer or git('config', 'user.name') or 'unknown', 'reviewed_at': date.today().isoformat(), 'signed_commit': git('rev-parse', 'HEAD')})
    with open(signoff_path(page), 'w') as f:
        json.dump(so, f, indent=2)
        f.write('\n')
    text = re.sub(r'^status:\s*\w+', 'status: reviewed', page['text'], count=1, flags=re.M)
    if text != page['text']:
        open(page['path'], 'w', encoding='utf-8').write(text)
    print(f'{page["rel"]}: signed {len(items)} items as {so["reviewer"]}')
    return 0


def cmd_diff(key):
    page = find_page(key)
    so = load_signoff(page) if page else None
    if not so:
        print(f'{key} has no sign-off')
        return 2
    print(git('diff', so['signed_commit'], '--', page['rel']) or 'no change since the sign-off commit')
    return 0


def main(argv):
    if not argv or argv[0] in ('-h', '--help'):
        print(__doc__)
        return 0
    cmd, rest = argv[0], argv[1:]
    reviewer = rest[rest.index('--reviewer') + 1] if '--reviewer' in rest else None
    only = rest[rest.index('--only') + 1].split(',') if '--only' in rest else None
    pos = [a for i, a in enumerate(rest) if not a.startswith('--') and (i == 0 or rest[i - 1] not in ('--reviewer', '--only'))]
    if cmd == 'status':
        return cmd_status()
    if cmd == 'sign' and pos:
        return cmd_sign(pos[0], reviewer, only)
    if cmd == 'diff' and pos:
        return cmd_diff(pos[0])
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
