#!/usr/bin/env python3
"""check.py: verification of the living specification (docs/spec) against the code, the tests and the sign-offs.

  check.py [--strict] [--base REF] [--fix-backlinks]
  check.py --guard

Errors (exit 1): broken front matter; an item id that does not belong to its page; a rule or behavior without a `[proof: ...]` clause; a proof that names a
test that does not exist (no test title carries the id); a `[code: path#Symbol]` whose file or symbol is missing; a scope glob that matches nothing; a link to
a concept, capability or model that does not exist; a state machine that is not well-formed, deterministic and total (models.py); signed items that changed.
A term whose Definition links, directly or through other terms, back to itself (circular definition).
Warnings (errors with --strict): items marked `[proof: none]`; code under a page's scope changed since --base while the page did not (a behavior change must
start in the page, or a commit says `livespec: no behavior change`); a concept nobody uses; missing sections; a stale "used by" block.

--guard exits 1 if a `.reviewed.json` differs from HEAD in the working tree (an automated run must never sign).
"""
import fnmatch
import glob
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402
import models  # noqa: E402
import sign  # noqa: E402

USED_BY = re.compile(r'(<!-- used-by:start -->)(.*?)(<!-- used-by:end -->)', re.S)
REQUIRED = {'capability': ['id', 'title', 'kind', 'status', 'depends_on', 'scope'], 'concept': ['id', 'title', 'kind', 'status', 'defined_by'],
            'model': ['id', 'title', 'kind', 'status'], 'term': ['id', 'title', 'kind', 'status']}
SECTIONS = {'capability': ['Purpose', 'Rules', 'Behaviors', 'Known gaps'], 'concept': ['Definition'], 'term': ['Definition']}


class Report:
    def __init__(self):
        self.errors, self.warns = [], []

    def error(self, where, msg):
        self.errors.append(f'ERROR {where}: {msg}')

    def warn(self, where, msg):
        self.warns.append(f'warn  {where}: {msg}')


def scope_files(globs):
    out = set()
    for g in globs:
        for p in glob.glob(os.path.join(common.ROOT, g), recursive=True):
            if os.path.isfile(p):
                out.add(os.path.relpath(p, common.ROOT))
    return out


def git(*args):
    return subprocess.run(['git', '-C', common.ROOT, *args], capture_output=True, text=True).stdout


def check_front(page, kind, rep):
    for k in REQUIRED[kind]:
        if k not in page['front']:
            rep.error(page['rel'], f'front matter lacks `{k}`')
    if page['front'].get('kind') != kind:
        rep.error(page['rel'], f'`kind` must be {kind}')
    if page['front'].get('status') not in ('draft', 'reviewed'):
        rep.error(page['rel'], '`status` must be draft or reviewed')
    for sec in SECTIONS.get(kind, []):
        if not re.search(r'^## %s\b' % re.escape(sec), page['body'], re.M):
            rep.warn(page['rel'], f'no "## {sec}" section')


def check_items(page, tests, rep, caps, concept_slugs, model_names, stats):
    pid = page['front'].get('id', '')
    seen = set()
    for it in page['items']:
        where = f'{page["rel"]} {it["id"]}'
        if it['id'] in seen:
            rep.error(where, 'duplicate item id')
        seen.add(it['id'])
        if not it['id'].startswith(pid + '.'):
            rep.error(where, f'item id must start with "{pid}."')
        proofs, codes = common.refs_of(it['text'])
        kind = it['id'].split('.')[1][0]   # R, B or C
        stats['items'] += 1
        if kind in 'RB':
            if not proofs:
                rep.error(where, 'a rule or behavior needs `[proof: ...]` (or `[proof: none]`, which says "no automated proof yet")')
            elif proofs == ['none']:
                stats['unproven'] += 1
                rep.warn(where, 'no automated proof yet')
            else:
                stats['proven'] += 1
        if kind in 'RB':
            for msg in common.style_problems(it['text']):
                stats['style'] = stats.get('style', 0) + 1
                rep.warn(where, 'style: ' + msg)
        for pr in proofs:
            if pr != 'none' and pr not in tests:
                rep.error(where, f'proof "{pr}": no test title carries that id (a test must say `it(\'{pr}: ...\')`)')
        for c in codes:
            ok, why = common.code_ref_ok(c)
            if not ok:
                rep.error(where, f'code ref: {why}')
    # links anywhere in the page
    for m in common.CONCEPT.finditer(page['text']):
        if m.group(1) not in concept_slugs:
            rep.error(page['rel'], f'{{{{concept:{m.group(1)}}}}} has no page in docs/spec/concepts')
    for m in common.CAP.finditer(page['text']):
        if m.group(1) not in caps:
            rep.error(page['rel'], f'{{{{cap:{m.group(1)}}}}} is not a capability of the catalog')
    for c in page['front'].get('concepts', []):
        if c not in concept_slugs:
            rep.error(page['rel'], f'front matter concept "{c}" has no page')
    for mname in page['front'].get('models', []):
        if mname not in model_names:
            rep.error(page['rel'], f'front matter model "{mname}" has no page or file in docs/spec/models')
    for d in page['front'].get('depends_on', []):
        if d not in caps:
            rep.error(page['rel'], f'depends_on "{d}" is not a capability of the catalog')


def used_by_block(slug, cap_pages):
    users = [p for p in cap_pages if slug in p['front'].get('concepts', []) or ('{{concept:%s}}' % slug) in p['text']]
    return users, '\n'.join(f'- {{{{cap:{p["front"]["id"]}}}}} {p["front"].get("title", "")}' for p in users) or '_nobody yet_'


def terms_cfg():
    try:
        import json
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'terms.config.json'), encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def used_by_terms(slug, term_page, page_terms, inv, all_pages):
    """Lines for the "used by" block of a term: each page that links it, with the rule ids that do."""
    rules = {}
    for p, it in inv.get(slug, []):
        rules.setdefault(p['path'], []).append(it['id'].split('.', 1)[1])
    out = []
    for p in all_pages:
        if p is term_page or (slug not in page_terms[p['path']] and p['path'] not in rules):
            continue
        rel = os.path.relpath(p['path'], os.path.dirname(term_page['path']))
        label = p['front'].get('id', os.path.splitext(os.path.basename(p['path']))[0])
        ids = rules.get(p['path'], [])
        out.append(f'- [{label}]({rel})' + (f': {", ".join(ids)}' if ids else ''))
    return out


def main(argv):
    if '--guard' in argv:
        changed = subprocess.run(['git', '-C', common.ROOT, 'diff', '--name-only', 'HEAD', '--', 'docs/spec'], capture_output=True, text=True).stdout.split('\n')
        changed += subprocess.run(['git', '-C', common.ROOT, 'ls-files', '--others', '--exclude-standard', '--', 'docs/spec'], capture_output=True, text=True).stdout.split('\n')
        touched = [p for p in changed if p.endswith('.reviewed.json')]
        if touched:
            print('sign-off files are human-only; this run changed: ' + ' '.join(touched))
            return 1
        return 0

    strict = '--strict' in argv
    fix = '--fix-backlinks' in argv
    base = argv[argv.index('--base') + 1] if '--base' in argv else None
    rep, stats = Report(), {'items': 0, 'proven': 0, 'unproven': 0}
    caps = common.capability_ids()
    cap_pages, con_pages = common.pages('capability'), common.pages('concept')
    concept_slugs = {common.slug_of(p) for p in con_pages}
    model_names = {common.slug_of(p) for p in common.pages('model')} | {os.path.splitext(os.path.basename(f))[0] for f in glob.glob(os.path.join(common.SPEC, 'models', '*.qnt'))}
    tests = common.test_index()

    for page in cap_pages:
        check_front(page, 'capability', rep)
        if not page['front'].get('id') or not common.slug_of(page).startswith(page['front'].get('id', '?') + '-'):
            rep.error(page['rel'], 'file name must start with "<id>-"')
        if page['front'].get('id') not in caps:
            rep.error(page['rel'], f'id {page["front"].get("id")} is not in scripts/sdd/capabilities.tsv')
        for g in page['front'].get('scope', []):
            if not scope_files([g]):
                rep.error(page['rel'], f'scope "{g}" matches no file')
        check_items(page, tests, rep, caps, concept_slugs, model_names, stats)
        known = common.all_routes()
        for claim in common.route_claims(page['body']):
            if claim not in known:
                rep.error(page['rel'], f'route `{claim}` is named under Entry points but no controller defines it')

    for page in con_pages:
        check_front(page, 'concept', rep)
        if page['front'].get('defined_by') not in caps:
            rep.error(page['rel'], f'defined_by "{page["front"].get("defined_by")}" is not a capability')
        check_items(page, tests, rep, caps, concept_slugs, model_names, stats)
        slug = common.slug_of(page)
        users, block = used_by_block(slug, cap_pages)
        if not users:
            rep.warn(page['rel'], 'no capability uses this concept')
        m = USED_BY.search(page['text'])
        if not m:
            rep.warn(page['rel'], 'no <!-- used-by:start --> block')
        elif m.group(2).strip() != block:
            if fix:
                with open(page['path'], 'w', encoding='utf-8') as f:
                    f.write(USED_BY.sub(lambda mm: mm.group(1) + '\n' + block + '\n' + mm.group(3), page['text']))
                print(f'backlinks updated: {page["rel"]}')
            else:
                rep.warn(page['rel'], 'the "used by" block is stale (run check.py --fix-backlinks)')

    # terms: the words the rules use, each defined once. A rule links the word ([section](../terms/page-section.md)); a term may link finer terms.
    term_pages = common.pages('term')
    terms_dir = os.path.join(common.SPEC, 'terms')
    all_pages = cap_pages + con_pages + term_pages
    page_terms = {p['path']: common.term_slugs_linked(p) for p in all_pages}
    inv = common.term_index(cap_pages + con_pages)
    for page in all_pages:
        for text, target in common.spec_links(page):
            if not os.path.isfile(target) and os.path.commonpath([target, common.SPEC]) == common.SPEC:
                rep.error(page['rel'], f'link "[{text}]" points at {os.path.relpath(target, common.ROOT)}, which does not exist')
    for page in term_pages:
        check_front(page, 'term', rep)
        slug = common.slug_of(page)
        if page['front'].get('id') != slug:
            rep.error(page['rel'], f'`id` must equal the file name ({slug})')
        users = used_by_terms(slug, page, page_terms, inv, all_pages)
        block = '\n'.join(users) or '_nobody yet_'
        # no drift: (1) the rules that use the word are fingerprinted; a changed rule asks for the definition to be read again (terms.py accept <slug> after reading it)
        stored, current = page['front'].get('rules_hash'), common.hash_of_items(inv.get(slug, []))
        if users and not stored:
            rep.warn(page['rel'], 'no `rules_hash`: run scripts/livespec/terms.py accept ' + slug)
        elif users and stored != 'pending' and stored != current:
            rep.warn(page['rel'], 'a rule that uses this word changed (or a new rule uses it) since the definition was written: read it again, then run scripts/livespec/terms.py accept ' + slug)
        # (2) no second copy of a fact: a number in the definition must be stated by a rule that links the term, or it will silently go wrong when the rule changes
        m_def = re.search(r'^## Definition\n(.*?)(?=^## |\Z)', page['body'], re.M | re.S)
        if m_def and inv.get(slug) and terms_cfg().get('numbers_in_definitions', 'forbid') == 'forbid':
            rule_numbers = set()
            for _, it in inv[slug]:
                rule_numbers |= common.numbers_in(it['norm'])
            stray = sorted(common.numbers_in(common.strip_refs(m_def.group(1))) - rule_numbers)
            if stray:
                rep.warn(page['rel'], 'the definition states ' + ', '.join(stray[:4]) + ' but no rule that links this term does: take the number out (the rule holds it) or the page will drift')
        if not users:
            rep.warn(page['rel'], 'no page links this term')
        m = USED_BY.search(page['text'])
        if not m:
            rep.warn(page['rel'], 'no <!-- used-by:start --> block')
        elif m.group(2).strip() != block:
            if fix:
                with open(page['path'], 'w', encoding='utf-8') as f:
                    f.write(USED_BY.sub(lambda mm: mm.group(1) + '\n' + block + '\n' + mm.group(3), page['text']))
                print(f'backlinks updated: {page["rel"]}')
            else:
                rep.warn(page['rel'], 'the "used by" block is stale (run check.py --fix-backlinks)')
    # definitions must not be circular: the links inside a Definition section form a directed graph that has to be acyclic (a word may not be explained by a word that is explained by it).
    # "Used by", Example and Known gaps are not part of that graph: they may point anywhere.
    graph = common.term_graph(term_pages)
    for comp in common.find_cycles(graph):
        rep.error('docs/spec/terms', 'circular definition: ' + ' <-> '.join(comp[:6]) + (f' (+{len(comp) - 6} more)' if len(comp) > 6 else '') + ' (reword one of the definitions so that it does not lean on the other; terms.py break-cycles does it)')
    # a concept that a sentence explains inline AND that has a term page now: the explanation is a second copy. Rules are not rewritten automatically (they may be signed): a person removes it.
    inline_tsv = os.path.join(terms_dir, 'inline.tsv')
    if os.path.exists(inline_tsv):
        have = {common.slug_of(p) for p in term_pages}
        for line in open(inline_tsv, encoding='utf-8'):
            f = line.rstrip('\n').split('\t')
            if len(f) >= 7 and not line.startswith('#') and f[4] in have:
                rep.warn(f'{f[0]} {f[1]}', f'explains "{f[2]}" inline ("{f[3][:50]}") but the term page {f[4]} exists: replace the explanation by the link')
    # a distinctive term (a title of two words or more, or with a hyphen/underscore/camel case) used bare in a rule: say it with the link, or the reader has to guess what it means.
    # One-word everyday titles ("event", "key", "store") are not reported: they are used in their ordinary sense far more often.
    words = {}
    for page in term_pages:
        t = page['front'].get('title', '')
        if t and (len(t.split()) >= 2 or re.search(r'[-_]|[a-z][A-Z]', t)):
            words[t.lower()] = common.slug_of(page)
    if words:
        pattern = re.compile(r'(?<![a-z0-9`-])(%s)(?![a-z0-9`-])' % '|'.join(re.escape(w) for w in sorted(words, key=len, reverse=True)))
        for page in cap_pages + con_pages:
            for it in page['items']:
                linked = common.term_slugs_linked({'path': page['path'], 'text': it['text']})
                for m in pattern.finditer(common.strip_refs(it['text']).lower()):
                    slug = words[m.group(1)]
                    if slug not in linked:
                        rep.warn(f'{page["rel"]} {it["id"]}', f'uses "{m.group(1)}" without linking its term [{m.group(1)}](../terms/{slug}.md)')
                        break

    # the formal layer
    for page in common.pages('model'):
        check_front(page, 'model', rep)
        mc = models.parse_machine(page['body'])
        if mc is not None:
            for sev, msg in models.check_machine(mc, page['front']):
                (rep.error if sev == 'error' else rep.warn)(page['rel'], msg)

    # sign-offs
    for page in cap_pages + con_pages:
        drift = sign.compare(page)
        if drift and (drift['changed'] or drift['removed']):
            rep.error(page['rel'], f'signed items changed since review: {" ".join(drift["changed"] + drift["removed"])} (re-read and sign again)')

    # code changed, page not
    if base:
        changed = set((git('diff', '--name-only', base) + git('ls-files', '--others', '--exclude-standard')).split('\n')) - {''}
        log = git('log', f'{base}..HEAD', '--format=%B')
        for page in cap_pages:
            pid = page['front'].get('id', '')
            hit = sorted(f for f in changed if not f.startswith('docs/spec/') and any(fnmatch.fnmatch(f, g.replace('**', '*')) for g in page['front'].get('scope', [])))
            if hit and page['rel'] not in changed and f'livespec: no behavior change' not in log:
                rep.warn(page['rel'], f'{len(hit)} file(s) in its scope changed since {base} (for example {hit[0]}) but the page did not; edit the page first, '
                                        'or say `livespec: no behavior change` in the commit message')

    for line in rep.errors + rep.warns:
        print(line)
    print(f'-- {len(cap_pages)} capability, {len(con_pages)} concept, {len(common.pages("model"))} model, {len(common.pages("term"))} term pages; {stats["items"]} items; rules and behaviors: '
          f'{stats["proven"]} with a proof, {stats["unproven"]} marked `[proof: none]`; {stats.get("style", 0)} style warnings; {len(rep.errors)} errors, {len(rep.warns)} warnings')
    return 1 if rep.errors or (strict and rep.warns) else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
