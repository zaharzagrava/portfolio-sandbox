#!/usr/bin/env python3
"""terms.py: take the words of a living-spec page apart, recursively, until every word is self-explanatory.

  terms.py expand <page.md> [--items R-01,C-02] [--max-depth 6] [--max-calls 80] [--model M] [--facts notes.md]
  terms.py consolidate [--apply]        merge pages that are the same concept, and drop single-use pages that only restate their rule (dry run without --apply)
  terms.py break-cycles                 make the definitions acyclic: a fundamental term may not lean on a peripheral one that is defined by it (the model rewrites the definition)
  terms.py promote                      a concept explained inline in one place that a second place needs becomes one shared term page, and every place links it
  terms.py accept <slug...>|--all     record that the definitions were read again after a rule changed
  terms.py plan   <page.md>            (no model call) which items would be read
  terms.py deepen [--max-depth 8] [--max-calls 400]      read the definition of every existing term again and write the pages it still needs

Two kinds of words. A general software-engineering or web word that means here what it means everywhere (HttpOnly, CSRF, JWT, circuit breaker, Server-Timing) gets NO page of
ours: it is linked to an authoritative public reference (MDN, an RFC, OWASP, the vendor's own docs). The script opens that page and checks it before it writes the link, and
the choice is kept in docs/spec/terms/external.tsv and listed in ONE glossary, docs/spec/sw-external-terms.md, which only marks the word as "general, not special
here" and points at the reference (it describes nothing). In the text such a link carries an arrow, [HttpOnly ↗](...); a link without one goes to a term page of ours. A rule links to the glossary entry, never to the outside page directly, so a dead or better URL is fixed in one place. A word of this system, or an everyday word with a special meaning here
("section", "errors entry", "page deadline"), gets one of our own term pages. A spec is not a textbook.

The depth is not fixed. For the rules and behaviors of a page (or for a term's own definition) a model with no tools lists the exact phrases that a junior engineer who has
never seen this system could not understand from the sentence alone: an everyday word with a special meaning here ("section", "entry", "budget"), a named thing of this
system (a header, a cookie, an error code), engineering jargon (CSRF, single-flight, fail-closed). Every such phrase gets ONE term page in docs/spec/terms (a second model
call writes it); the definition is then read the same way, so a term that leans on another unexplained word gets that word's page too, and so on, until a definition raises
nothing new or the depth/call limit is reached (reported, so a person knows the layer is not finished).

The model never rewrites a rule. It only names phrases that appear verbatim; this script inserts the link `[phrase](../terms/slug.md)` at the first occurrence inside that
item, so the meaning (and the hash of a signed item changes only by the links, which a reviewer sees in the diff).
"""
import concurrent.futures
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

TERMS = os.path.join(common.SPEC, 'terms')
CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'terms.config.json')
DEFAULTS = {'find_model': None, 'define_model': None, 'consolidate_model': None, 'granularity': 'normal', 'merge_synonyms': 'conservative', 'prune_single_use': 'conservative',
            'definition_max_sentences': 5, 'definition_max_words_per_sentence': 25, 'numbers_in_definitions': 'forbid', 'find_chunk_items': 10, 'define_batch_terms': 6,
            'workers': 3, 'max_depth': 8, 'max_calls': 300, 'extra_reference_hosts': []}


def load_config():
    """The levers: defaults, then terms.config.json, then TERMS_<NAME> environment variables. Command-line flags override all of them."""
    cfg = dict(DEFAULTS)
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, encoding='utf-8') as f:
            cfg.update({k: v for k, v in json.load(f).items() if not k.startswith('_')})
    for k, v in DEFAULTS.items():
        env = os.environ.get('TERMS_' + k.upper())
        if env not in (None, ''):
            cfg[k] = int(env) if isinstance(v, int) else env
    return cfg


CFG = load_config()
EXTERNAL_TSV = os.path.join(TERMS, 'external.tsv')
INLINE_TSV = os.path.join(TERMS, 'inline.tsv')
ALLOWED_HOSTS = tuple(CFG['extra_reference_hosts']) + ('developer.mozilla.org', 'datatracker.ietf.org', 'www.rfc-editor.org', 'owasp.org', 'cheatsheetseries.owasp.org', 'martinfowler.com', 'graphql.org', 'www.w3.org', 'redis.io', 'www.postgresql.org', 'docs.nestjs.com', 'nextjs.org', 'playwright.dev', 'www.elastic.co', 'kafka.apache.org', 'microservices.io', 'en.wikipedia.org', 'docs.aws.amazon.com', 'learn.microsoft.com', 'web.dev', 'jwt.io', 'oauth.net', 'openid.net', 'docs.stripe.com', 'sre.google', 'opentelemetry.io', 'www.cloudflare.com')
GRANULARITY_TEXT = {
    'strict': 'GRANULARITY strict: make a page ONLY for a word that a junior engineer would certainly misread or could not find out alone (an everyday word with a special meaning here, a named mechanism of this system). Skip names that are clear from the sentence.',
    'normal': 'GRANULARITY normal: make a page for words the reader would have to guess, as described above.',
    'loose': 'GRANULARITY loose: also make pages for the named things of this system (codes, headers, cookies, limits, states) even when the sentence hints at their meaning.'}
MERGE_TEXT = {
    'conservative': 'When unsure, leave the pages alone.',
    'aggressive': 'Merge whenever the two pages could be one page without confusing a reader, including a parent that only splits one case from the other.'}
PRUNE_TEXT = {
    'conservative': 'When unsure, KEEP.',
    'aggressive': 'INLINE whenever the rule plus the word itself would let a junior engineer guess right most of the time.'}
RUBRIC = """A reader is a junior backend engineer who has never seen this system and reads ONE sentence. A phrase needs its own explanation page when:
 (a) it is an everyday word that means something specific here (for example "section", "entry", "budget", "required", "breaker", "aggregate"), because the reader would guess;
 (b) it names a thing of this system (a header, a cookie, an error code, a table, a queue, a limit that has a reason);
 (c) it is engineering jargon a junior may not know (CSRF, single-flight, fail-closed, DataLoader, idempotency).
It needs NO page when it is plain English, a standard HTTP status used in its standard meaning, `null`, JSON, a number with its unit, or already explained in the same sentence.
Pick the smallest exact phrase, copied character for character from the text (keep backticks if the text has them). At most 6 phrases per item. Prefer reusing an existing term.
TWO KINDS. kind "external": a general software-engineering or web concept that means here exactly what it means everywhere (HttpOnly, CSRF, JWT, circuit breaker, DataLoader, Server-Timing, Cache-Control,
idempotency, OAuth, SHA-256): do NOT write our own page; give the URL of the best official or authoritative reference (MDN for the web platform, an RFC for a protocol, OWASP for security, the vendor's own docs
for a product, martinfowler.com or microservices.io for a pattern). Only these hosts are accepted: developer.mozilla.org, datatracker.ietf.org, www.rfc-editor.org, owasp.org, cheatsheetseries.owasp.org, martinfowler.com, graphql.org, www.w3.org, redis.io, www.postgresql.org, docs.nestjs.com, nextjs.org, playwright.dev, www.elastic.co, kafka.apache.org, microservices.io, en.wikipedia.org, docs.aws.amazon.com, learn.microsoft.com, web.dev, jwt.io, oauth.net, openid.net, docs.stripe.com, sre.google, opentelemetry.io, www.cloudflare.com. Give a page you are SURE exists; the script opens it and drops the link if it
does not load or does not mention the concept. kind "project": a word of THIS system, or an everyday word with a special meaning here ("section", "errors entry", "page deadline", "dependent section", this
system's own codes and limits): our own page. When unsure whether a word is general or special here, choose project. A general concept with a parameter that is special here is still external (the parameter
is already in the rule's text).
@@GRANULARITY@@
Never make a page for a rule or item id (C-01, R-05, B-12), for a capability (S13, W02, "the payment gateway" as a name of a capability), for a page title, or for a number. An error code, status or header VALUE that is only the visible effect of a mechanism that has (or will have) its own page
does not get its own page: give the mechanism's slug (for example CIRCUIT_OPEN -> circuit-breaker, 403 csrf_invalid -> csrf-token). Use one slug for singular, plural and spelling variants."""
RUBRIC = RUBRIC.replace("@@GRANULARITY@@", GRANULARITY_TEXT.get(CFG["granularity"], GRANULARITY_TEXT["normal"]))


def call_model(prompt, model=None):
    env = dict(os.environ)
    env.setdefault('CLAUDE_CONFIG_DIR', os.path.expanduser('~/.claude-personal'))
    env.pop('ANTHROPIC_API_KEY', None)
    cmd = ['claude', '-p', '--tools', '', '--no-session-persistence', '--output-format', 'text'] + (['--model', model] if model else [])
    with tempfile.TemporaryDirectory() as scratch:
        r = subprocess.run(cmd, input=prompt, capture_output=True, text=True, cwd=scratch, env=env, timeout=900)
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError(f'model call failed: rc={r.returncode} {r.stderr[-300:]}')
    return r.stdout


MODEL_FN = call_model   # replaced in tests


def parse_json(text):
    text = re.sub(r'^```(?:json)?\s*|\s*```\s*$', '', text.strip())
    m = re.search(r'[\[{]', text)
    return json.JSONDecoder().raw_decode(text[m.start():])[0] if m else []


def slugify(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')


def load_terms():
    out = {}
    for p in common.pages('term'):
        out[common.slug_of(p)] = {'title': p['front'].get('title', ''), 'aliases': p['front'].get('aliases', []), 'path': p['path']}
    return out


def terms_listing(terms):
    return '\n'.join(f'- {s}: {t["title"]}' + (f' (also: {", ".join(t["aliases"])})' if t['aliases'] else '') for s, t in sorted(terms.items())) or '(none yet)'


def prose_of(item_text):
    """The sentence part of an item, without [proof: ...] and [code: ...]."""
    return re.sub(r'\s*\[(?:proof|code):[^\]]*\]', '', item_text).strip()


def load_externals():
    out = {}
    if os.path.exists(EXTERNAL_TSV):
        for line in open(EXTERNAL_TSV, encoding='utf-8'):
            f = line.rstrip('\n').split('\t')
            if len(f) >= 4 and not line.startswith('#'):
                out[f[0]] = {'title': f[1], 'url': f[2], 'source': f[3], 'aliases': [a for a in (f[4] if len(f) > 4 else '').split(',') if a]}
    return out


def save_external(slug, title, url, source, aliases):
    os.makedirs(TERMS, exist_ok=True)
    new = not os.path.exists(EXTERNAL_TSV)
    with open(EXTERNAL_TSV, 'a', encoding='utf-8') as f:
        if new:
            f.write('# slug\ttitle\turl\tsource\taliases   (general concepts: linked to an authoritative reference instead of explained here; checked when written)\n')
        f.write(f'{slug}\t{title}\t{url}\t{source}\t{",".join(aliases)}\n')


GLOSSARY = os.path.join(common.SPEC, 'sw-external-terms.md')
CUE = ' ↗'   # a general term is marked in the text with an arrow: it is not special here, look it up outside


def render_glossary():
    rows = sorted(load_externals().items(), key=lambda kv: kv[1]['title'].lower())
    lines = ['# General software terms used in the specification', '',
             'Words that mean here what they mean everywhere. They are NOT explained in this specification: each entry only marks the word and points at the reference.',
             'A rule links to its entry; this file is generated by `scripts/livespec/terms.py` from `terms/external.tsv`. Words with a special meaning in this system are in [`terms/`](terms/).', '']
    for slug, e in rows:
        lines.append(f'- <a id="{slug}"></a>**{e["title"]}**: [{e["source"] or urlparse(e["url"]).netloc}]({e["url"]})')
    with open(GLOSSARY, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')


def glossary_url(from_path, slug):
    return os.path.relpath(GLOSSARY, os.path.dirname(from_path)) + '#' + slug


def externals_listing():
    return '\n'.join(f'- {s}: {e["title"]} -> {e["url"]}' for s, e in sorted(load_externals().items())) or ''


_URL_CACHE = {}


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (spec link check)'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status, r.read(400_000).decode('utf-8', 'replace')


FETCH_FN = fetch   # replaced in tests


def verify_url(url, title):
    """-> (ok, why). The host is on the allow-list, the page loads, and it mentions the concept."""
    if url in _URL_CACHE:
        return _URL_CACHE[url]
    host = urlparse(url).netloc
    if not url.startswith('https://') or host not in ALLOWED_HOSTS:
        res = (False, f'host {host or "?"} is not on the allow-list')
    else:
        try:
            status, body = FETCH_FN(url)
            words = [w for w in re.findall(r'[a-z0-9]+', title.lower()) if len(w) >= 4] or re.findall(r'[a-z0-9]+', title.lower())
            res = (True, '') if status == 200 and any(w in body.lower() for w in words) else (False, f'status {status} or the page does not mention "{title}"')
        except Exception as e:  # noqa: BLE001
            res = (False, f'cannot open it: {e}')
    _URL_CACHE[url] = res
    return res


def find_phrases(blocks, terms, model, fresh=False):
    """blocks: {key: text} -> {key: [{'phrase', 'slug', 'title', 'aliases'}]} ; only phrases that occur verbatim in their text.
    The text is read in chunks that run at the same time; an answer is cached by the hash of the text, so text that did not change costs no call."""
    keys = list(blocks)
    chunk = int(CFG['find_chunk_items'])
    chunks = [keys[i:i + chunk] for i in range(0, len(keys), chunk)]
    existing = f'{terms_listing(terms)}\n{externals_listing()}'
    out = {}

    def one(ks):
        part = {k: blocks[k] for k in ks}
        ck = hashlib.sha256((RUBRIC + json.dumps(part, sort_keys=True)).encode()).hexdigest()[:20]
        cpath = os.path.join(TERMS, '.cache', ck + '.json')
        if not fresh and os.path.exists(cpath):
            with open(cpath, encoding='utf-8') as f:
                return json.load(f)
        listing = '\n'.join(f'### {k}\n{t}' for k, t in part.items())
        prompt = f"""{RUBRIC}

Existing term pages (kind project) and references (kind external); reuse their slug when the phrase means the same:
{existing}

For each text below list the phrases that need a page. Answer with JSON only: an object whose keys are the headings and whose values are lists of
{{"phrase": "<verbatim from the text>", "kind": "project" or "external", "url": "<external only: the reference page>", "source": "<external only: for example MDN>", "slug": "<kebab-case, reuse an existing slug if it fits>", "title": "<short name of the term, as a reader would look it up>", "aliases": ["<other spellings used in the specs>"]}}.
An empty list means every word of that text is self-explanatory.
If a sentence ALREADY explains a phrase itself (a parenthesis, an appositive, "that is ...", "meaning ..."), do not list it above; list it instead in an extra key "_inline": a list of
{{"key": "<heading>", "phrase": "<verbatim>", "span": "<the verbatim words of the sentence that explain it>", "slug": "<kebab-case>", "title": "<short name>"}}. Only real in-sentence explanations.

{listing}
"""
        try:
            data = parse_json(MODEL_FN(prompt, model))
        except (RuntimeError, ValueError) as e:
            print(f'  (find step failed: {e})', file=sys.stderr)
            return None
        if not isinstance(data, dict):
            return None
        res = {}
        inl = []
        for e in data.get('_inline', []) if isinstance(data.get('_inline'), list) else []:
            if isinstance(e, dict) and e.get('key') in part and e.get('phrase') in part[e['key']] and e.get('span') and e['span'] in part[e['key']] and e.get('slug'):
                inl.append({'key': e['key'], 'phrase': e['phrase'], 'span': e['span'], 'slug': slugify(e['slug']), 'title': e.get('title') or e['slug']})
        res['_inline'] = inl
        for k in ks:
            good = []
            for e in data.get(k, []):
                ph = (e.get('phrase') or '').strip()
                if ph and ph in part[k] and e.get('slug') and not re.match(r'^(rule|item|r|b|c)-?\d+|^[swj]\d{2}-', slugify(e['slug'])) and not re.fullmatch(r'[A-Za-z0-9]+\.[RBC]-\d+', ph):
                    good.append({'phrase': ph, 'slug': slugify(e['slug']), 'kind': 'external' if e.get('kind') == 'external' else 'project', 'url': (e.get('url') or '').strip(),
                                 'source': e.get('source') or '', 'title': e.get('title') or e['slug'], 'aliases': [a for a in e.get('aliases', []) if isinstance(a, str)]})
            res[k] = good
        os.makedirs(os.path.dirname(cpath), exist_ok=True)
        with open(cpath, 'w', encoding='utf-8') as f:
            json.dump(res, f)
        return res

    with concurrent.futures.ThreadPoolExecutor(max_workers=int(CFG['workers'])) as pool:
        for r in pool.map(one, chunks):
            if r:
                inl = r.pop('_inline', [])
                out.update(r)
                out.setdefault('_inline', []).extend(inl)
    return out


NUMBER_TEXT = {'forbid': "Do NOT state numbers, limits, durations or counts: the rules hold the values, and a number copied here goes stale when a rule changes (say 'the page deadline' not '1,000 ms').",
               'allow': 'Numbers are allowed when a rule states them.'}


def define_prompt(jobs, terms, facts, note=''):
    head = """Write the explanation page of each term below. Each is a term of a software system, for a junior backend engineer who has never seen it.

Facts you may use (the page the term comes from, and verified notes from the code). Use ONLY these and general engineering knowledge; never invent a number, a name, an endpoint or a path.
When you give a reason that is design intent and not stated in the facts, say "design intent (not stated in the spec)".
%s

General web and engineering concepts (cookies, headers, HTTP, JWT, CSRF, caches, hashing) are linked to public references: do NOT explain them; write only what is specific to this system.
Pages that already exist (you may use these words freely, they are linked automatically; do not re-explain them):
%s

For EACH term answer with a line '=== <slug>' and then exactly this markdown, nothing else between terms:
## Definition
<2 to %d short sentences in plain English: what it is and what it does in this system. %s No sentence over %d words. You may use other words of this system without explaining them (they get their own page and link); do NOT re-explain words that have a page or that are obviously their own concept (do not define "the BFF" again, for example).>

## Example
<one concrete example with real names from the facts, 1 to 4 lines; a code block for JSON or headers if clearer. Numbers are allowed here; mark invented values as illustrative>

## Known gaps
<at most 3 bullets, ONLY gaps that would matter to someone relying on this term, each starting "The spec does not say ..." or "Not confirmed in the code: ...". Leave this whole section out if there is nothing that matters.>
""" % (facts, terms_listing(terms), CFG['definition_max_sentences'], NUMBER_TEXT[CFG['numbers_in_definitions']], CFG['definition_max_words_per_sentence'])
    body = '\n'.join(f'TERM {j["slug"]}: {j["title"]}  (seen in the text as: {j["phrase"]})\nFound in: {j["context"]}\n' for j in jobs)
    return head + (f'\nThe owner read an earlier version and asks: {note}\n' if note else '') + '\n' + body


def write_terms(jobs, terms, model, defined_for, facts='', note='', overwrite=False):
    """jobs: [{'slug','title','aliases','phrase','context'}] -> the slugs written. One call for the whole batch; a term missing from the answer is asked for alone."""
    done = []

    def ask(batch):
        try:
            raw = MODEL_FN(define_prompt(batch, terms, facts, note), model)
        except RuntimeError as e:
            print(f'  ({e})', file=sys.stderr)
            return {}
        parts = {}
        for m in re.finditer(r'^=== *([a-z0-9-]+)\s*\n(.*?)(?=^=== |\Z)', raw, re.M | re.S):
            body = re.sub(r'^```(?:markdown|md)?\n|\n```\s*$', '', m.group(2).strip())
            if '## Definition' in body:
                parts[m.group(1)] = body
        if len(batch) == 1 and not parts and '## Definition' in raw:
            parts[batch[0]['slug']] = raw.strip()
        return parts
    bodies = {}
    size = int(CFG['define_batch_terms'])
    batches = [jobs[i:i + size] for i in range(0, len(jobs), size)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=int(CFG['workers'])) as pool:
        for parts in pool.map(ask, batches):
            bodies.update(parts)
        missing = [j for j in jobs if j['slug'] not in bodies]
        for parts in pool.map(ask, [[j] for j in missing]):
            bodies.update(parts)
    for j in jobs:
        body = bodies.get(j['slug'])
        if not body:
            print(f'  (no definition for {j["slug"]})', file=sys.stderr)
            continue
        taken = {t['title'].lower() for t in terms.values()} | set(terms)
        al = ', '.join(sorted({a.lower() for a in j['aliases'] if a.lower() != j['title'].lower() and a.lower() not in taken and slugify(a) not in taken}))
        page = (f'---\nid: {j["slug"]}\ntitle: {j["title"]}\nkind: term\nstatus: draft\naliases: [{al}]\ndefined_for: {defined_for}\nrules_hash: pending\n---\n# {j["title"]}\n{body}\n\n'
                f'## Used by\n<!-- used-by:start -->\n_nobody yet_\n<!-- used-by:end -->\n')
        path = os.path.join(TERMS, j['slug'] + '.md')
        with open(path, 'w', encoding='utf-8') as f:
            f.write(page)
        terms[j['slug']] = {'title': j['title'], 'aliases': [a.lower() for a in j['aliases']], 'path': path}
        done.append(j['slug'])
    return done


def claim_term(slug):
    """Several pages may be expanded at the same time (separate processes): the first one to ask owns a new term; the others use it."""
    os.makedirs(TERMS, exist_ok=True)
    try:
        fd = os.open(os.path.join(TERMS, slug + '.md'), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return False
    os.write(fd, b'(being written)\n')
    os.close(fd)
    return True


def link_first(text, phrase, url, cue=''):
    """Link the first occurrence of `phrase` that is not already inside a markdown link. -> (new text, linked?)"""
    spans = [m.span() for m in common.MD_LINK.finditer(text)]
    start = 0
    while True:
        i = text.find(phrase, start)
        if i < 0:
            return text, False
        j = i + len(phrase)
        if not any(a <= i < b for a, b in spans):
            return text[:i] + f'[{phrase}{cue}]({url})' + text[j:], True
        start = j


def item_range(text, item_id):
    m = re.search(r'^- \*\*%s\*\*.*(?:\n  .*)*' % re.escape(item_id), text, re.M)
    return (m.start(), m.end()) if m else None


def relurl(from_path, slug):
    return os.path.relpath(os.path.join(TERMS, slug + '.md'), os.path.dirname(from_path))


def apply_links(path, spans_text, found, ids=None, whole_section=None, guard=None):
    """Insert the links of `found` ({key: [phrases]}) into the file; keys are item ids (or the name of a block for a term page)."""
    with open(path, encoding='utf-8') as f:
        text = f.read()
    n = 0
    for key, entries in found.items():
        rng = item_range(text, key) if ids else whole_section(text)
        if not rng:
            continue
        a, b = rng
        seg = text[a:b]
        for e in entries:
            if not e.get('url') and e['slug'] == os.path.splitext(os.path.basename(path))[0]:
                continue   # a term does not link itself
            if guard and not e.get('url') and not guard(e['slug']):
                continue   # this link would make a definition circular: the word stays plain here
            seg, ok = link_first(seg, e['phrase'], glossary_url(path, e['slug']) if e.get('url') else relurl(path, e['slug']), CUE if e.get('url') else '')
            n += ok
        text = text[:a] + seg + text[b:]
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    return n


def set_hashes(slugs):
    """Record the fingerprint of the rules that use each term (check.py warns when it changes)."""
    pages = common.pages('capability') + common.pages('concept')
    inv = common.term_index(pages)
    defs_inv = common.term_definition_index(common.pages('term'))
    n = 0
    for slug in slugs:
        path = os.path.join(TERMS, slug + '.md')
        if not os.path.exists(path):
            continue
        with open(path, encoding='utf-8') as f:
            text = f.read()
        h = common.hash_of_items(inv.get(slug, []), defs_inv.get(slug, ()))
        new = re.sub(r'^rules_hash:.*$', f'rules_hash: {h}', text, count=1, flags=re.M)
        if new == text and 'rules_hash:' not in text:
            new = text.replace('\n---\n', f'\nrules_hash: {h}\n---\n', 1)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(new)
        n += 1
    return n


def term_section(text):
    m = re.search(r'^## Definition.*?(?=^## Used by|\Z)', text, re.M | re.S)
    return (m.start(), m.end()) if m else None


def register_external(e):
    """-> True if the reference is now in the registry (checked once, under a lock, because pages may be expanded at the same time)."""
    os.makedirs(TERMS, exist_ok=True)
    with open(os.path.join(TERMS, '.lock'), 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        ex = load_externals().get(e['slug'])
        if ex:
            e['url'] = ex['url']
            return True
        ok, why = verify_url(e['url'], e['title']) if e['url'] else (False, 'no url given')
        if ok:
            save_external(e['slug'], e['title'], e['url'], e['source'], [a.lower() for a in e['aliases']])
            render_glossary()
            print(f'  reference {e["slug"]} -> {e["url"]}')
            return True
        print(f'  (no link for "{e["phrase"]}": {why})', file=sys.stderr)
        return False


def expand(page_path, only=None, max_depth=6, max_calls=300, model=None, facts_file=None, define_model=None, fresh=False):
    define_model = define_model or model
    terms = load_terms()
    if page_path is None:   # deepen: read the definition of every term again
        page, page_path = {'body': '', 'items': []}, os.path.join(TERMS, 'README.md')
    else:
        page = common.load_page(page_path)
    facts = f'--- page {os.path.basename(page_path)} ---\n{page["body"][:12000]}\n' + (f'--- verified notes from the code ---\n{open(facts_file, encoding="utf-8").read()}\n' if facts_file else '')
    calls = 0
    created, linked, unfinished = [], 0, []
    items = [it for it in page['items'] if (not only or it['id'].split('.', 1)[-1] in only or it['id'] in only)]
    blocks = {it['id']: prose_of(it['text']) for it in items}
    if page_path.endswith('README.md') and not items:
        pending = []
        for slug, t in sorted(terms.items()):
            with open(t['path'], encoding='utf-8') as f:
                tt = f.read()
            rng = term_section(tt)
            if rng:
                pending.append((1, t['path'], {slug: tt[rng[0]:rng[1]]}, False))
    elif not blocks:
        print('no items to read'); return 0
    else:
        pending = [(0, page_path, blocks, True)]
    defined_for = os.path.splitext(os.path.basename(page_path))[0]
    while pending:
        depth, path, blk, is_items = pending.pop(0)
        if calls >= max_calls:
            unfinished.append(os.path.basename(path)); continue
        terms = load_terms()   # other pages may be expanded at the same time and add terms
        calls += max(1, -(-len(blk) // int(CFG['find_chunk_items'])))
        found = find_phrases(blk, terms, model, fresh)
        record_inline(path, found.pop('_inline', []), is_items)
        externals = load_externals()
        for entries in found.values():
            for e in entries:
                if e['kind'] == 'external' or e['slug'] in externals:
                    if e['slug'] in externals:
                        e['url'] = externals[e['slug']]['url']
                    elif not register_external(e):
                        e['url'] = ''; e['skip'] = True
        todo, seen, mine = [], set(), set()
        for key, entries in found.items():
            for e in entries:
                if e.get('url') or e.get('skip') or e['slug'] in terms or e['slug'] in seen:
                    continue
                seen.add(e['slug'])
                if depth >= max_depth or calls + len(todo) >= max_calls:
                    unfinished.append(e['slug']); continue
                if claim_term(e['slug']):
                    mine.add(e['slug'])
                    todo.append({'slug': e['slug'], 'title': e['title'], 'aliases': e['aliases'], 'phrase': e['phrase'], 'context': blk[key]})
        calls += -(-len(todo) // int(CFG['define_batch_terms'])) if todo else 0
        written = write_terms(todo, terms, define_model, defined_for, facts)
        for slug in mine - set(written):   # release a claim that produced nothing, so a later run can try again
            try:
                os.remove(os.path.join(TERMS, slug + '.md'))
            except OSError:
                pass
        for slug in written:
            created.append(slug)
            print(f'  term {slug} (layer {depth + 1})')
        terms = load_terms()
        entries_ok = {k: [e for e in v if e.get('url') or (e['slug'] in terms and not e.get('skip'))] for k, v in found.items()}
        guard = None
        if not is_items:
            me = os.path.splitext(os.path.basename(path))[0]
            graph = common.term_graph(common.pages('term'))

            def guard(target, me=me, graph=graph):
                if common.reaches(graph, target, me):
                    return False
                graph.setdefault(me, set()).add(target)
                return True
        linked += apply_links(path, None, entries_ok, ids=is_items, whole_section=term_section, guard=guard)
        for slug in written:
            with open(terms[slug]['path'], encoding='utf-8') as f:
                tt = f.read()
            rng = term_section(tt)
            if rng:
                pending.append((depth + 1, terms[slug]['path'], {slug: tt[rng[0]:rng[1]]}, False))
    set_hashes(created)
    promoted = promote(define_model, facts)
    if promoted:
        print(f'  promoted to term pages (a second place needs them): {", ".join(promoted)}')
    print(f'{os.path.basename(page_path)}: {len(created)} term page(s) written, {linked} link(s) inserted, about {calls} model call(s)')
    if unfinished:
        print(f'NOT FINISHED (limit reached): {", ".join(sorted(set(unfinished)))}: run again, or raise --max-depth / --max-calls')
    return 0


def load_inline():
    rows = []
    if os.path.exists(INLINE_TSV):
        for line in open(INLINE_TSV, encoding='utf-8'):
            f = line.rstrip('\n').split('\t')
            if len(f) >= 7 and not line.startswith('#'):
                rows.append({'path': f[0], 'key': f[1], 'phrase': f[2], 'span': f[3], 'slug': f[4], 'title': f[5], 'status': f[6]})
    return rows


def save_inline(rows):
    os.makedirs(TERMS, exist_ok=True)
    clean = lambda x: re.sub(r'[\t\n]+', ' ', x)   # noqa: E731
    with open(INLINE_TSV, 'w', encoding='utf-8') as f:
        f.write('# page\titem\tphrase\tspan that explains it inline\tslug\ttitle\tstatus (open: only one place uses the concept, so no page; promoted: a page exists now)\n')
        for r in rows:
            f.write('\t'.join(clean(r[k]) for k in ('path', 'key', 'phrase', 'span', 'slug', 'title', 'status')) + '\n')


def record_inline(path, entries, is_items):
    """A sentence that explains a phrase by itself needs no page while only one place uses the concept; remember it, so that a second place promotes it."""
    if not entries or not is_items:
        return
    rel = os.path.relpath(path, common.ROOT)
    rows = load_inline()
    have = {(r['path'], r['key'], r['phrase']) for r in rows}
    for e in entries:
        if (rel, e['key'], e['phrase']) not in have:
            rows.append({'path': rel, 'key': e['key'], 'phrase': e['phrase'], 'span': e['span'], 'slug': e['slug'], 'title': e['title'], 'status': 'open'})
    save_inline(rows)


def promote(model, facts=''):
    """The reverse of inlining. A concept that one sentence explains by itself stays without a page; once a second place needs it (another sentence explains or uses it, or a page for
    it exists), it becomes one shared term page and every place links it. The inline explanations stay in the rules (never rewritten automatically: they may be signed) and are
    reported by check.py as duplicates for a person to remove. -> slugs promoted."""
    rows = load_inline()
    if not rows:
        return []
    terms = load_terms()
    by = {}
    for r in rows:
        by.setdefault(r['slug'], []).append(r)
    done = []
    for slug, rs in by.items():
        places = {(r['path'], r['key']) for r in rs}
        if slug not in terms and len({p for p, _ in places}) < 2:
            continue
        if slug not in terms:
            if not claim_term(slug):
                continue
            ctx = ' | '.join(r['span'] for r in rs[:3])
            w = write_terms([{'slug': slug, 'title': rs[0]['title'], 'aliases': [], 'phrase': rs[0]['phrase'], 'context': ctx}], terms, model, 'inline-promotion', facts)
            if not w:
                try:
                    os.remove(os.path.join(TERMS, slug + '.md'))
                except OSError:
                    pass
                continue
            done.append(slug)
        for r in rs:
            apply_links(os.path.join(common.ROOT, r['path']), None, {r['key']: [{'phrase': r['phrase'], 'slug': slug}]}, ids=True)
            r['status'] = 'promoted'
    save_inline(rows)
    set_hashes(done)
    return done


def redo(slug, note, model):
    """Write one term again, with the owner's remark (the earlier version is shown to the model). One call, about half a minute."""
    terms = load_terms()
    if slug not in terms:
        print(f'no term {slug}'); return 2
    with open(terms[slug]['path'], encoding='utf-8') as f:
        old = f.read()
    front, _ = common.parse_front(old)
    defined_for = front.get('defined_for', '')
    src = next(iter(glob_pages(defined_for)), None)
    facts = f'--- page {defined_for} ---\n{common.read(src)[:12000]}\n' if src else ''
    used = [i for p in common.pages('capability') + common.pages('concept') for i in common.linking_items(slug, [p])][:6]
    ctx = ' | '.join(t for _, t in used) or front.get('title', slug)
    job = {'slug': slug, 'title': front.get('title', slug), 'aliases': front.get('aliases', []), 'phrase': front.get('title', slug), 'context': ctx}
    note_full = f'{note}\n\nThe earlier version:\n{old}'
    done = write_terms([job], terms, model, defined_for, facts, note_full)
    set_hashes(done)
    print('rewritten' if done else 'failed')
    return 0 if done else 1


def glob_pages(name):
    import glob as _g
    return _g.glob(os.path.join(common.SPEC, 'capabilities', name + '*.md')) + _g.glob(os.path.join(common.SPEC, 'concepts', name + '.md'))


def main(argv):
    if not argv or argv[0] not in ('expand', 'plan', 'deepen', 'accept', 'redo', 'consolidate', 'break-cycles', 'promote'):
        print(__doc__); return 2
    opt = lambda n, d=None: argv[argv.index(n) + 1] if n in argv else d   # noqa: E731
    if argv[0] == 'accept':   # a person (or agent) has read the definitions again after a rule changed
        slugs = [os.path.splitext(f)[0] for f in sorted(os.listdir(TERMS)) if f.endswith('.md')] if '--all' in argv[1:] else argv[1:]
        print(f'{set_hashes(slugs)} term(s) accepted'); return 0
    if argv[0] == 'promote':
        print('promoted:', ', '.join(promote(opt('--model') or CFG['define_model'])) or 'none'); return 0
    if argv[0] == 'break-cycles':
        return break_cycles(opt('--model') or CFG['define_model'])
    if argv[0] == 'consolidate':
        return consolidate(opt('--model') or CFG['consolidate_model'], '--apply' in argv)
    if argv[0] == 'redo':
        return redo(argv[1], opt('--note', 'Write it again, better.'), opt('--define-model') or opt('--model') or CFG['define_model'])
    model = opt('--find-model') or opt('--model') or CFG['find_model']
    dmodel = opt('--define-model') or opt('--model') or CFG['define_model']
    if argv[0] == 'deepen':
        return expand(None, None, int(opt('--max-depth', CFG['max_depth'])), int(opt('--max-calls', 400)), model, opt('--facts'), dmodel, '--fresh' in argv)
    path = os.path.abspath(argv[1])
    only = set((opt('--items') or '').split(',')) - {''}
    if argv[0] == 'plan':
        pg = common.load_page(path)
        print(f'{len(pg["items"])} items; terms already: {len(load_terms())}'); return 0
    return expand(path, only or None, int(opt('--max-depth', CFG['max_depth'])), int(opt('--max-calls', CFG['max_calls'])), model, opt('--facts'), dmodel, '--fresh' in argv)



# ---- consolidate: fewer, better pages -------------------------------------------------------------------------------------------------------------------------

def spec_pages():
    return common.pages('capability') + common.pages('concept') + common.pages('term')


def rewrite_links(old_slug, new_slug):
    """Point every link to terms/old.md at terms/new.md (or, with new_slug=None, remove the link and keep its text). -> number of pages changed."""
    changed = 0
    for p in spec_pages():
        text = p['text']
        def sub(m):
            tgt = os.path.normpath(os.path.join(os.path.dirname(p['path']), m.group(2).split('#')[0]))
            if tgt != os.path.join(TERMS, old_slug + '.md'):
                return m.group(0)
            if new_slug is None:
                return re.sub(r'\s*↗$', '', m.group(1)) if False else m.group(1)
            return f'[{m.group(1)}]({os.path.relpath(os.path.join(TERMS, new_slug + ".md"), os.path.dirname(p["path"]))})'
        new = common.MD_LINK.sub(sub, text)
        if new != text:
            with open(p['path'], 'w', encoding='utf-8') as f:
                f.write(new)
            changed += 1
    return changed


def consolidate(model=None, apply=False, prune_batch=20):
    terms = load_terms()
    pages = common.pages('capability') + common.pages('concept')
    inv = common.term_index(pages)
    # 1 synonyms: one reading of the whole list
    listing = '\n'.join(f'{s}: {t["title"]}' + (f' (aliases: {", ".join(t["aliases"])})' if t['aliases'] else '') for s, t in sorted(terms.items()))
    prompt = f"""Below are the term pages of a software specification: slug: title (aliases). Some pages are the SAME concept written twice under different names (for example a cookie
named once as "session cookie" and once as "bff session cookie"), because they were written at the same time from different rules. Find those. Two pages are the same only if one
definition could replace the other without losing anything; a parent and a child concept are NOT the same, and neither are two different error codes, headers or cookies.
Answer with JSON only: a list of {{"keep": "<slug>", "merge": ["<slug>", ...]}}. {MERGE_TEXT.get(CFG['merge_synonyms'], MERGE_TEXT['conservative'])}

{listing}
"""
    groups = []
    if CFG['merge_synonyms'] != 'off':
        try:
            groups = parse_json(MODEL_FN(prompt, model))
        except (RuntimeError, ValueError) as e:
            print(f'merge step failed: {e}')
    merges = [(g['keep'], [m for m in g.get('merge', []) if m in terms and m != g['keep']]) for g in groups if isinstance(g, dict) and g.get('keep') in terms]
    merges = [(k, ms) for k, ms in merges if ms]
    print(f'synonyms: {sum(len(ms) for _, ms in merges)} page(s) into {len(merges)} page(s)')
    for k, ms in merges:
        print(f'  {k} <- {", ".join(ms)}')
    # 2 pages that only restate their one rule
    single = [s for s in terms if len(inv.get(s, [])) <= 1 and not any(s in common.term_slugs_linked(tp) for tp in common.pages('term') if common.slug_of(tp) != s)]
    drops = []
    def judge(batch):
        parts = []
        for s in batch:
            with open(terms[s]['path'], encoding='utf-8') as f:
                tt = f.read()
            rng = term_section(tt)
            rule = inv[s][0][1]['norm'] if inv.get(s) else '(no rule)'
            parts.append(f'### {s}: {terms[s]["title"]}\\nRULE THAT LINKS IT: {rule}\\nPAGE: {tt[rng[0]:rng[1]] if rng else ""}')
        pr = f"""For each term page below, decide whether it earns its place. KEEP when a junior engineer reading the rule would still have to guess what the word means, or when the page adds a
fact or a reason that the rule does not state. INLINE when the rule's own sentence already makes the word clear, or the page only restates the rule. {PRUNE_TEXT.get(CFG['prune_single_use'], PRUNE_TEXT['conservative'])}
Answer with JSON only: an object {{"<slug>": "KEEP" or "INLINE"}}.

""" + '\\n\\n'.join(parts)
        try:
            ans = parse_json(MODEL_FN(pr, model))
        except (RuntimeError, ValueError):
            return []
        return [s for s in batch if isinstance(ans, dict) and str(ans.get(s, '')).upper() == 'INLINE']
    batches = [single[i:i + prune_batch] for i in range(0, len(single), prune_batch)] if CFG['prune_single_use'] != 'off' else []
    with concurrent.futures.ThreadPoolExecutor(max_workers=int(CFG['workers'])) as pool:
        for r in pool.map(judge, batches):
            drops += r
    print(f'single-use pages that only restate their rule: {len(drops)} of {len(single)} judged')
    for s in drops[:40]:
        print(f'  inline {s}')
    if not apply:
        print('(dry run: nothing changed; add --apply)'); return 0
    for k, ms in merges:
        for m in ms:
            rewrite_links(m, k)
            kp = terms[k]['path']
            front = open(kp, encoding='utf-8').read()
            extra = {terms[m]['title'].lower()} | set(terms[m]['aliases'])
            mm = re.search(r'^aliases: \\[(.*)\\]$', front, re.M)
            have = {a.strip() for a in mm.group(1).split(',') if a.strip()} if mm else set()
            if mm:
                front = front.replace(mm.group(0), 'aliases: [' + ', '.join(sorted(have | extra)) + ']', 1)
                open(kp, 'w', encoding='utf-8').write(front)
            os.remove(terms[m]['path'])
    for s in drops:
        if s in {m for _, ms in merges for m in ms}:
            continue
        rewrite_links(s, None)
        if os.path.exists(terms[s]['path']):
            os.remove(terms[s]['path'])
    print(f'done: {len(load_terms())} term pages left')
    return 0


def break_cycles(model=None, rounds=4):
    """Make the definition graph acyclic. A fundamental term (used by many rules and terms) must not lean on a peripheral one: in every cycle the links that point from a more
    used term to a less used one are cut, and the model rewrites that definition in plain words so that it no longer needs the cut term. A fallback keeps the text and removes the link."""
    for rnd in range(1, rounds + 1):
        tp = common.pages('term')
        graph = common.term_graph(tp)
        cycles = common.find_cycles(graph)
        if not cycles:
            print(f'round {rnd}: no circular definition left'); return 0
        inv = common.term_index(common.pages('capability') + common.pages('concept'))
        indeg = {}
        for u, vs in graph.items():
            for v in vs:
                indeg[v] = indeg.get(v, 0) + 1
        rank = {s: (len(inv.get(s, [])) + indeg.get(s, 0), s) for s in graph}   # more used = more fundamental; the slug breaks ties
        cut = {}
        for comp in cycles:
            members = set(comp)
            for u in comp:
                for v in graph[u] & members:
                    if rank[v] < rank[u]:   # a fundamental term leaning on a peripheral one
                        cut.setdefault(u, set()).add(v)
        print(f'round {rnd}: {len(cycles)} cycle group(s), {sum(len(c) for c in cycles)} terms; {sum(len(v) for v in cut.values())} link(s) to cut in {len(cut)} definition(s)')
        titles = {common.slug_of(p): p['front'].get('title', common.slug_of(p)) for p in tp}
        by_slug = {common.slug_of(p): p for p in tp}

        def rewrite(u):
            page = by_slug[u]
            rng = term_section(page['text'])
            if not rng:
                return u, None
            a, b = rng
            definition = re.search(r'^## Definition\n(.*?)(?=^## |\Z)', page['text'][a:b], re.M | re.S).group(1).strip()
            avoid = [f'{titles[v]} (the link ../terms/{v}.md or {v}.md)' for v in sorted(cut[u])]
            pr = f"""Rewrite the Definition of ONE term of a software specification so that it no longer depends on some other terms: those terms are defined in terms of this one, and a definition
may not be circular. Keep every fact. Say the same thing in plain English WITHOUT using the avoided words and without linking them (describe what they stand for in a few ordinary words, or
leave them out if the sentence still holds). Keep every other link exactly as written. No numbers that are not already there. 2 to 5 short sentences. Answer with the new Definition text only
(no heading).

Term: {titles[u]}
Avoid: {'; '.join(avoid)}
Current Definition:
{definition}
"""
            try:
                return u, MODEL_FN(pr, model).strip()
            except RuntimeError:
                return u, None
        with concurrent.futures.ThreadPoolExecutor(max_workers=int(CFG['workers'])) as pool:
            results = list(pool.map(rewrite, sorted(cut)))
        for u, new in results:
            page = by_slug[u]
            text = page['text']
            m = re.search(r'(^## Definition\n)(.*?)(?=^## |\Z)', text, re.M | re.S)
            old_def = m.group(2)
            bad = lambda t: any(common.MD_LINK.search(t) and v in ''.join(x[1] for x in [(None, mm.group(2)) for mm in common.MD_LINK.finditer(t)]) for v in cut[u])   # noqa: E731
            def has_cut_link(t):
                for mm in common.MD_LINK.finditer(t):
                    tgt = os.path.splitext(os.path.basename(mm.group(2).split('#')[0]))[0]
                    if tgt in cut[u] and 'terms' in mm.group(2) or tgt in cut[u] and not mm.group(2).startswith('http'):
                        return True
                return False
            if not new or has_cut_link(new) or '## ' in new:
                # fallback: keep the words, drop the links
                new = old_def
                for v in cut[u]:
                    new = common.MD_LINK.sub(lambda mm, v=v: mm.group(1) if os.path.splitext(os.path.basename(mm.group(2).split('#')[0]))[0] == v and not mm.group(2).startswith('http') else mm.group(0), new)
                print(f'  {u}: links removed (the model did not produce a clean rewrite)')
            else:
                new = new + '\n\n'
                print(f'  {u}: rewritten')
            with open(page['path'], 'w', encoding='utf-8') as f:
                f.write(text[:m.start(2)] + new.rstrip('\n') + '\n\n' + text[m.end(2):])
    left = common.find_cycles(common.term_graph(common.pages('term')))
    print(f'{len(left)} cycle group(s) left after {rounds} rounds')
    return 0 if not left else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
