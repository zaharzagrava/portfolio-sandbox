"""Shared parsing for the living specification (docs/spec): pages, items, references, and the test and code indexes.

A page is markdown with a small front matter (see docs/spec/README.md). An item is a list entry that starts with a bold id:
    - **S13.R-01** The same order has at most one payment. [proof: S13 AS-07] [code: packages/.../payment.repository.ts#insertAccepted]
References inside an item or anywhere in the page: [proof: ...], [code: path#Symbol], {{concept:slug}}, {{cap:S13}}.
"""
import glob
import hashlib
import os
import re

ROOT = os.environ.get('LIVESPEC_ROOT') or os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SPEC = os.path.join(ROOT, 'docs', 'spec')

FRONT = re.compile(r'\A---\n(.*?)\n---\n', re.S)
ITEM_START = re.compile(r'^- \*\*([A-Za-z0-9-]+\.[RBC]-\d+)\*\*\s*(.*)$')
PROOF = re.compile(r'\[proof:\s*([^\]]*)\]')
CODE = re.compile(r'\[code:\s*([^\]]*)\]')
CONCEPT = re.compile(r'\{\{concept:([a-z0-9-]+)\}\}')
CAP = re.compile(r'\{\{cap:([SWJ]\d{2})\}\}')
TEST_FILE = re.compile(r'\.(e2e-spec|spec|test|journey-spec)\.tsx?$')
CITE = re.compile(r'''['"`]([SWJ]\d{2}) ((?:AS|G)-\d+)\b''')
SKIP_DIRS = {'node_modules', 'dist', '.next', '.git', 'test-results', 'playwright-report', '.cache'}


def read(path, **kw):
    with open(path, encoding='utf-8', errors=kw.get('errors', 'strict')) as f:
        return f.read()


def parse_front(text):
    """-> (dict, body). Our own subset: `key: value`, `key: [a, b]`, and a block list of `  - item` lines."""
    m = FRONT.match(text)
    if not m:
        return {}, text
    data, key = {}, None
    for line in m.group(1).split('\n'):
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        if re.match(r'^\s+- ', line) and key:
            data.setdefault(key, [])
            if isinstance(data[key], list):
                data[key].append(line.strip()[2:].strip())
            continue
        k, _, v = line.partition(':')
        key = k.strip()
        v = re.sub(r'\s+#.*$', '', v).strip()
        if v.startswith('[') and v.endswith(']'):
            data[key] = [x.strip() for x in v[1:-1].split(',') if x.strip()]
        elif v == '':
            data[key] = []
        else:
            data[key] = v
    return data, text[m.end():]


def parse_items(body):
    """-> list of {'id', 'text', 'line'} for every `- **ID**` entry; continuation lines (indented) belong to the item."""
    items, cur = [], None
    for n, line in enumerate(body.split('\n'), 1):
        m = ITEM_START.match(line)
        if m:
            cur = {'id': m.group(1), 'text': m.group(2).strip(), 'line': n}
            items.append(cur)
        elif cur and line.startswith('  ') and line.strip():
            cur['text'] += ' ' + line.strip()
        else:
            cur = None
    for it in items:
        it['norm'] = re.sub(r'\s+', ' ', it['text']).strip()
        it['hash'] = hashlib.sha256(it['norm'].encode()).hexdigest()[:12]
    return items


def refs_of(text):
    proofs = []
    for m in PROOF.finditer(text):
        proofs += [x.strip() for x in m.group(1).split(',') if x.strip()]
    codes = []
    for m in CODE.finditer(text):
        codes += [x.strip() for x in m.group(1).split(',') if x.strip()]
    return proofs, codes


def load_page(path):
    text = read(path)
    front, body = parse_front(text)
    return {'path': path, 'rel': os.path.relpath(path, ROOT), 'front': front, 'body': body, 'text': text, 'items': parse_items(body)}


def pages(kind):
    folder = {'capability': 'capabilities', 'concept': 'concepts', 'model': 'models', 'term': 'terms'}[kind]
    return [load_page(p) for p in sorted(glob.glob(os.path.join(SPEC, folder, '*.md')))]


def walk_files(roots, suffix_ok=lambda name: True):
    for r in roots:
        base = os.path.join(ROOT, r)
        for dp, dn, fn in os.walk(base):
            dn[:] = [d for d in dn if d not in SKIP_DIRS]
            for name in fn:
                if suffix_ok(name):
                    yield os.path.join(dp, name)


def test_index():
    """{'S13 AS-12': [(relpath, line), ...]} from test titles."""
    idx = {}
    for p in walk_files(['packages'], lambda n: bool(TEST_FILE.search(n))):
        try:
            lines = read(p, errors='ignore').split('\n')
        except OSError:
            continue
        for n, line in enumerate(lines, 1):
            for m in CITE.finditer(line):
                idx.setdefault(f'{m.group(1)} {m.group(2)}', []).append((os.path.relpath(p, ROOT), n))
    return idx


def split_code_ref(ref):
    path, _, sym = ref.partition('#')
    return path.strip(), sym.strip()


def code_ref_ok(ref):
    """-> (ok, why). The file must exist; a #Symbol must occur in it as a word."""
    path, sym = split_code_ref(ref)
    full = os.path.join(ROOT, path)
    if not os.path.isfile(full):
        return False, f'file not found: {path}'
    if sym:
        text = read(full, errors='ignore')
        if not re.search(r'(?<![A-Za-z0-9_])%s(?![A-Za-z0-9_])' % re.escape(sym), text):
            return False, f'symbol {sym} not found in {path}'
    return True, ''


def capability_ids():
    ids = {}
    p = os.path.join(ROOT, 'scripts', 'sdd', 'capabilities.tsv')
    if os.path.exists(p):
        for line in read(p).split('\n'):
            if line.startswith('#') or not line.strip():
                continue
            f = line.rstrip('\n').split('\t')
            if re.fullmatch(r'[SWJ]\d{2}', f[0]) and len(f) > 3:
                ids[f[0]] = {'domain': f[1], 'slug': f[2], 'title': f[3]}
    return ids


def slug_of(page):
    return os.path.splitext(os.path.basename(page['path']))[0]


# Style: a few ideas of controlled technical English (ASD-STE100) that make a rule checkable: no vague words, one obligation vocabulary (MUST,
# MUST NOT, SHOULD, MAY as in RFC 2119), short sentences. A heuristic: it reports, it does not forbid.
VAGUE = ['appropriate', 'appropriately', 'proper', 'properly', 'correct', 'correctly', 'valid', 'invalid', 'as needed', 'if necessary', 'etc', 'and so on',
         'fast', 'quickly', 'slow', 'robust', 'user-friendly', 'easy', 'simple', 'reasonable', 'usually', 'normally', 'typically', 'some', 'various', 'might', 'could',
         'should', 'tries to', 'attempts to', 'handles', 'deals with', 'supports']
MAX_WORDS = 30


MD_LINK = re.compile(r'(?<!\!)\[([^\]\[]+)\]\(([^)\s]+)\)')


def spec_links(page):
    """-> [(text, target path or None)] for every relative markdown link of a page that points at another markdown file; the target is made absolute.
    Links to terms are how a rule says what a word means: [section](../terms/page-section.md)."""
    out = []
    for m in MD_LINK.finditer(re.sub(r'`[^`]*`', '', page['text'])):
        target = m.group(2).split('#')[0]
        if not target.endswith('.md') or re.match(r'^[a-z]+:', target):
            continue
        out.append((m.group(1), os.path.normpath(os.path.join(os.path.dirname(page['path']), target))))
    return out


def term_slugs_linked(page):
    terms_dir = os.path.join(SPEC, 'terms')
    return {os.path.splitext(os.path.basename(t))[0] for _, t in spec_links(page) if os.path.dirname(t) == terms_dir}


def linking_items(slug, pages):
    """-> [(item id, normalized text)] of the rules and behaviors of `pages` that link the term `slug`."""
    out = []
    for p in pages:
        for it in p['items']:
            if slug in term_slugs_linked({'path': p['path'], 'text': it['text']}):
                out.append((it['id'], it['norm']))
    return sorted(out)


def definition_links(page):
    """The terms that a term's own Definition section links: the edges of the dependency graph. (Example, Known gaps and Used by may point anywhere: they explain nothing.)"""
    m = re.search(r'^## Definition\n(.*?)(?=^## |\Z)', page['body'], re.M | re.S)
    if not m:
        return set()
    return term_slugs_linked({'path': page['path'], 'text': m.group(1)}) - {os.path.splitext(os.path.basename(page['path']))[0]}


def term_graph(term_pages):
    return {slug_of(p): definition_links(p) for p in term_pages}


def find_cycles(graph):
    """Strongly connected components with more than one term (Tarjan, iterative). A definition that needs a word whose definition needs the first is circular. -> [[slug, ...]]"""
    index, low, on, stack, out, counter = {}, {}, set(), [], [], [0]
    for root in graph:
        if root in index:
            continue
        work = [(root, iter(sorted(graph.get(root, ()))))]
        index[root] = low[root] = counter[0]; counter[0] += 1; stack.append(root); on.add(root)
        while work:
            v, it = work[-1]
            adv = False
            for w in it:
                if w not in graph:
                    continue
                if w not in index:
                    index[w] = low[w] = counter[0]; counter[0] += 1; stack.append(w); on.add(w)
                    work.append((w, iter(sorted(graph.get(w, ())))))
                    adv = True
                    break
                if w in on:
                    low[v] = min(low[v], index[w])
            if adv:
                continue
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[v])
            if low[v] == index[v]:
                comp = []
                while True:
                    w = stack.pop(); on.discard(w); comp.append(w)
                    if w == v:
                        break
                if len(comp) > 1:
                    out.append(sorted(comp))
    return out


def reaches(graph, start, target):
    seen, todo = set(), [start]
    while todo:
        v = todo.pop()
        if v == target:
            return True
        if v in seen:
            continue
        seen.add(v); todo.extend(graph.get(v, ()))
    return False


def term_index(pages):
    """-> {slug: [(page, item)]} for every rule or behavior that links a term, built in one pass (the per-term search was quadratic and took minutes)."""
    inv = {}
    for p in pages:
        for it in p['items']:
            for slug in term_slugs_linked({'path': p['path'], 'text': it['text']}):
                inv.setdefault(slug, []).append((p, it))
    return inv


def definition_text(page):
    m = re.search(r'^## Definition\n(.*?)(?=^## |\Z)', page['body'], re.M | re.S)
    return re.sub(r'\s+', ' ', m.group(1)).strip() if m else ''


def term_definition_index(term_pages):
    """-> {slug: [(linking term, its definition text)]}: a term was written with the definitions that use it as part of its context, so when one of those changes it may be stale too."""
    inv = {}
    for p in term_pages:
        text = definition_text(p)
        for slug in definition_links(p):
            inv.setdefault(slug, []).append((slug_of(p), text))
    return inv


def hash_of_items(pairs, defs=()):
    """Fingerprint of everything a term was written from: the rules that link it, and the definitions of the terms that link it. The term graph is acyclic, so a change travels
    down it one step at a time, as each flagged definition is read again (and perhaps edited)."""
    lines = [f'{i}\t{t}' for i, t in sorted((it['id'], it['norm']) for _, it in pairs)] + [f'def:{s}\t{t}' for s, t in sorted(defs)]
    return hashlib.sha256('\n'.join(lines).encode()).hexdigest()[:12]


def term_rules_hash(slug, pages):
    """A fingerprint of the rules that use a term. A term page records it when it is written; when a rule that uses the word changes, or a new rule starts using it,
    the fingerprint differs and check.py asks for the definition to be read again (the same idea as a signed rule, without a person's signature)."""
    return hashlib.sha256('\n'.join(f'{i}\t{t}' for i, t in linking_items(slug, pages)).encode()).hexdigest()[:12]


NUMBER = re.compile(r'(?<![\w.])\d[\d,]*(?:\.\d+)?(?![\w])')


def numbers_in(text):
    return {n.replace(',', '') for n in NUMBER.findall(text)} - {'0', '1', '2', '3'}


def strip_refs(text):
    text = re.sub(r'\{\{[^}]*\}\}|\[(?:proof|code):[^\]]*\]', '', text)
    return MD_LINK.sub(r'\1', text)


def style_problems(text):
    """-> list of short messages for one rule or behavior."""
    plain = strip_refs(text)
    out = []
    low = ' ' + re.sub(r'[^a-z0-9 -]', ' ', plain.lower()) + ' '
    found = [w for w in VAGUE if f' {w} ' in low]
    if found:
        out.append('vague word(s): ' + ', '.join(found[:4]) + ' (say exactly what, with a number or a name)')
    for sentence in re.split(r'(?<=[.!?])\s+', plain.strip()):
        n = len(sentence.split())
        if n > MAX_WORDS:
            out.append(f'a sentence of {n} words (the limit is {MAX_WORDS}): {sentence[:50]}...')
            break
    return out


def norm_route(path):
    path = re.sub(r'[?#].*$', '', path.strip())
    path = re.sub(r'\{[A-Za-z0-9_.]+\}', ':p', path)
    path = re.sub(r'/+', '/', '/' + path)
    path = re.sub(r'^/(api/)?', '/', path)
    path = re.sub(r':[A-Za-z0-9_]+|\[[A-Za-z0-9_.]+\]', ':p', path)
    return path.rstrip('/') or '/'


_ROUTES = None


def all_routes():
    """{'POST /payments/intents', ...} from the Nest decorators of every controller (global prefix `api` ignored)."""
    global _ROUTES
    if _ROUTES is None:
        _ROUTES = set()
        for p in walk_files(['packages/backend/libs', 'packages/backend/apps'], lambda n: n.endswith('.ts') and not TEST_FILE.search(n)):
            t = read(p, errors='ignore')
            if '@Controller' not in t:
                continue
            ctrl = re.search(r"@Controller\(\s*(?:\{[^}]*path:\s*)?['\"]([^'\"]*)", t)
            prefix = ctrl.group(1) if ctrl else ''
            for m in re.finditer(r"@(Get|Post|Put|Patch|Delete)\(\s*(?:['\"]([^'\"]*)['\"])?", t):
                _ROUTES.add(f'{m.group(1).upper()} {norm_route("/" + prefix + "/" + (m.group(2) or ""))}')
    return _ROUTES


ROUTE_CLAIM = re.compile(r'`(GET|POST|PUT|PATCH|DELETE)\s+(/[^`\s]*)`')


def route_claims(body):
    m = re.search(r'^## Entry points\s*\n(.*?)(?=^## |\Z)', body, re.M | re.S)
    return [f'{a} {norm_route(b)}' for a, b in ROUTE_CLAIM.findall(m.group(1))] if m else []
