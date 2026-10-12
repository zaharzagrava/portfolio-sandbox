#!/usr/bin/env python3
"""generate.py: the one-run generator of the FIRST DRAFT of the living specification (docs/spec) from the code, the tests and the work-order specs.

  generate.py --facts [--only S13,S01]      print what would be fed to the model for each capability (no model calls)
  generate.py --concepts | --system         only the concept pages (from the capability pages that exist) / only system.md
  generate.py [--only S13,S01] [--jobs N] [--model M] [--force]
                                            write docs/spec/capabilities/<id>-<slug>.md for every built capability, then the concept pages, then system.md

Not part of the build loop: a living page is authored from the moment a human edits it. Only pages with `status: draft` are overwritten (--force: all).
The model is called as `claude -p` with no tools, in a scratch directory, with a prompt that holds only facts extracted by this script (build-spec scenarios,
files and their exported symbols, routes, events, queues, tables, test ids and titles). Every `[proof: ...]` and `[code: ...]` in the answer is verified
against the repository afterwards; what cannot be verified is removed and listed under "Known gaps", never kept.
"""
import concurrent.futures
import glob
import os
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

ROOT = common.ROOT
SPEC_DIRS = ['specs/domains', 'specs/web', 'specs/journeys']

# Concepts shared by several capabilities: a closed list, so every page uses the same names. slug -> (title, the capability that defines it).
CONCEPTS = {
    'problem-json-errors': ('Errors as problem+json', 'S54'),
    'request-context': ('Request context and tracing', 'S54'),
    'transaction-runner': ('Transactions and the transaction runner', 'S54'),
    'idempotency-key': ('Idempotency keys', 'S54'),
    'outbox-task-queue': ('The outbox: events and tasks', 'S53'),
    'projection-and-replay': ('Projections, versions and replay', 'S53'),
    'job-scheduler-lease': ('Scheduled jobs and leases', 'S49'),
    'cache-layers': ('Layered cache and single-flight', 'S52'),
    'rate-limit-policy': ('Rate-limit policies', 'S50'),
    'realtime-topic-stream': ('Realtime topics and the stream', 'S51'),
    'access-token-session': ('Access tokens and sessions', 'S01'),
    'tenant-shop-rbac': ('Shops as tenants and roles', 'S03'),
    'order-reservation': ('Orders, reservations and stock', 'S10'),
    'payment-lifecycle': ('Payments and their lifecycle', 'S13'),
    'search-index': ('The product search index', 'S32'),
    'bff-aggregate': ('The BFF and page aggregates', 'S48'),
}
MODELS_OF = {'S13': ['payment-status', 'charge-delivery'], 'S10': ['order-status']}


def sh(*args):
    return subprocess.run(['git', '-C', ROOT, *args], capture_output=True, text=True).stdout


def built_capabilities():
    out = {}
    cat = common.capability_ids()
    for base in SPEC_DIRS:
        for d in sorted(glob.glob(os.path.join(ROOT, base, '*'))):
            cid = os.path.basename(d).split('-')[0]
            if cid in cat and any(os.path.exists(os.path.join(d, m)) for m in ('.implemented', '.implemented-P1')):
                out[cid] = {**cat[cid], 'dir': d}
    return out


def read(p):
    return common.read(p, errors='ignore')


def spec_facts(d):
    text = read(os.path.join(d, 'spec.md'))
    prio, scenarios, frs = None, [], []
    for line in text.split('\n'):
        m = re.match(r'^###\s+User Story\b.*\(Priority:\s*(P\d)\)', line)
        if m:
            prio = m.group(1)
        m = re.match(r'^\s*\d+\.\s+\*\*(AS-\d+)[^*]*\*\*\s*[—–-]*\s*(.*)$', line)
        if m:
            scenarios.append((m.group(1), prio, re.sub(r'\s+', ' ', m.group(2))[:320]))
        m = re.match(r'^- \*\*(FR-\d+)\*\*:?\s*(.*)$', line)
        if m:
            frs.append((m.group(1), re.sub(r'\s+', ' ', m.group(2))[:260]))
    m = re.search(r'^\*\*Depends on\*\*:?\s*(.*)$', text, re.M)
    depends = sorted(set(re.findall(r'\b[SWJ]\d{2}\b', m.group(1)))) if m else []
    scope = re.search(r'^## Scope\s*\n(.*?)(?=^## )', text, re.M | re.S)
    return {'scenarios': scenarios, 'frs': frs, 'depends': depends, 'scope_text': re.sub(r'\s+', ' ', scope.group(1))[:900] if scope else ''}


def scope_of(cid, d, tests):
    files = set()
    for h in sh('log', '--format=%h', '--grep', f'^feat(.*): {cid} ').split():
        files |= set(sh('show', '--name-only', '--format=', h).split())
    for name in ('tasks.md', 'plan.md', 'gaps.md'):
        p = os.path.join(d, name)
        if os.path.exists(p):
            files |= set(re.findall(r'`?((?:packages|infra|scripts)/[A-Za-z0-9_./@\[\]()-]+\.(?:ts|tsx|json|conf|sql|yaml|yml))`?', read(p)))
    for key, hits in tests.items():
        if key.startswith(cid + ' '):
            files |= {h[0] for h in hits}
    ok = sorted(f for f in files if f and os.path.isfile(os.path.join(ROOT, f)) and not re.search(r'__screenshots__|node_modules|\.reviewed\.json|pnpm-lock', f))
    return ok


SHARED_DIRS = ('packages/backend/db', 'packages/backend/libs/common/config', 'infra/docker', 'packages/backend/libs/domains/billing')


def glob_of(files):
    """Directory globs for the capability's own non-test code: a directory with at least two of its files, never a shared one or a package root."""
    count = {}
    for f in files:
        if common.TEST_FILE.search(f) or f.startswith(('specs/', 'docs/')):
            continue
        parts = f.split('/')
        if f.startswith('packages/backend/libs/') and len(parts) > 5:
            d = '/'.join(parts[:5])
        elif f.startswith('packages/backend/apps/') and len(parts) > 6:
            d = '/'.join(parts[:6])
        elif f.startswith('packages/web/') and len(parts) > 4:
            d = '/'.join(parts[:4])
        elif f.startswith('packages/contracts/src/') and len(parts) > 4:
            d = '/'.join(parts[:4])
        else:
            continue
        if d.startswith(SHARED_DIRS):
            continue
        count[d] = count.get(d, 0) + 1
    keep = sorted(d for d, n in count.items() if n >= 2 and os.path.isdir(os.path.join(ROOT, d)))
    return [d + '/**' for d in keep]


def exports_of(path):
    t = read(os.path.join(ROOT, path))
    names = re.findall(r'export\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|function|const|interface|type|enum)\s+([A-Za-z0-9_]+)', t)
    return names[:14]


def code_facts(files):
    routes, events, queues, tables = [], [], [], []
    for f in files:
        if common.TEST_FILE.search(f) or not f.endswith(('.ts', '.tsx')):
            continue
        t = read(os.path.join(ROOT, f))
        ctrl = re.search(r"@Controller\(\s*['\"]([^'\"]*)", t)
        for m in re.finditer(r"@(Get|Post|Put|Patch|Delete)\(\s*['\"]?([^'\")]*)", t):
            routes.append(f'{m.group(1).upper()} /{(ctrl.group(1) + "/" if ctrl else "")}{m.group(2)}'.replace('//', '/') + f'  [{os.path.basename(f)}]')
        for m in re.finditer(r"defineEvent\(\s*['\"]([a-z0-9_.]+)['\"]", t):
            events.append(m.group(1))
        for m in re.finditer(r"(?:export )?const ([A-Z_]*QUEUE[A-Z_]*)\s*=\s*['\"]([a-z0-9._-]+)['\"]", t):
            queues.append(f'{m.group(2)}  [{m.group(1)} in {os.path.basename(f)}]')
        for m in re.finditer(r"tableName:\s*['\"]([A-Za-z0-9_]+)['\"]|@Table\(\s*\{[^}]*modelName:\s*['\"]([A-Za-z0-9_]+)", t):
            tables.append(m.group(1) or m.group(2))
        if f.startswith('packages/web/app/') and f.endswith(('page.tsx', 'route.ts')):
            routes.append('page /' + re.sub(r'^packages/web/app/|/?(page\.tsx|route\.ts)$', '', f) + f'  [{f}]')
    return {k: sorted(set(v)) for k, v in dict(routes=routes, events=events, queues=queues, tables=tables).items()}


def excerpts(files, budget=36000):
    """The first lines of the files that say most: controllers, domain rules/state, events, ports. Bounded."""
    def rank(f):
        n = os.path.basename(f)
        return (0 if 'controller' in n or n.endswith('page.tsx') else 1 if '/domain/' in f else 2 if 'events' in n or 'port' in n else 3, len(f))
    out, used = [], 0
    for f in sorted((f for f in files if not common.TEST_FILE.search(f) and f.endswith(('.ts', '.tsx')) and '/contracts/' not in f), key=rank):
        text = '\n'.join(read(os.path.join(ROOT, f)).split('\n')[:90])
        if used + len(text) > budget:
            continue
        out.append(f'--- {f}\n{text}')
        used += len(text)
        if len(out) >= 9:
            break
    return '\n\n'.join(out)


def facts_for(cid, info, tests):
    d = info['dir']
    spec = spec_facts(d)
    files = scope_of(cid, d, tests)
    cites = {k: v for k, v in tests.items() if k.startswith(cid + ' ')}
    return {'id': cid, 'info': info, 'spec': spec, 'files': files, 'code': code_facts(files), 'cites': cites, 'glob': glob_of(files)}


TEMPLATE = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'page-prompt.md')).read() if os.path.exists(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'page-prompt.md')) else ''


def title_of_test(cid_as):
    return cid_as


def build_prompt(f, built):
    cid, info, spec = f['id'], f['info'], f['spec']
    lines = [TEMPLATE, '', f'# FACTS for capability {cid}: {info["title"]} (domain: {info["domain"]})', '']
    lines.append('## Work-order specification (what the builder was asked to build; scenario ids are the proof ids)')
    lines.append('Scope: ' + spec['scope_text'])
    lines.append('Depends on: ' + (', '.join(spec['depends']) or 'none stated'))
    lines.append('Scenarios (id, story priority, text):')
    for sid, prio, text in spec['scenarios']:
        lines.append(f'- {cid} {sid} [{prio}] {text}')
    lines.append('Functional requirements:')
    for fid, text in spec['frs']:
        lines.append(f'- {fid}: {text}')
    lines += ['', '## Tests that carry a scenario id (a `[proof: ...]` may name only ids from this list)']
    for key, hits in sorted(f['cites'].items(), key=lambda kv: (len(kv[0]), kv[0])):
        lines.append(f'- {key}  ({hits[0][0].split("/")[-1]})')
    lines += ['', '## Files of the capability and the symbols they export (a `[code: path#Symbol]` may use only these)']
    for p in f['files']:
        if common.TEST_FILE.search(p) or p.startswith('specs/'):
            continue
        ex = exports_of(p) if p.endswith(('.ts', '.tsx')) else []
        lines.append(f'- {p}' + (f'  exports: {", ".join(ex)}' if ex else ''))
    lines += ['', '## Facts read from the code']
    for k, label in (('routes', 'Routes and pages'), ('events', 'Events defined'), ('queues', 'Queues'), ('tables', 'Tables/models')):
        if f['code'][k]:
            lines.append(f'{label}:' + (f' (first 40 of {len(f["code"][k])})' if len(f['code'][k]) > 40 else ''))
            lines += [f'- {x}' for x in f['code'][k][:40]]
    lines += ['', '## Excerpts of the most telling files', excerpts(f['files'])]
    lines += ['', '## Other built capabilities (for depends_on and {{cap:..}} links)', ', '.join(f'{k} ({v["title"][:40]})' for k, v in built.items() if k != cid)]
    lines += ['', '## Shared concepts you may link (closed list: use only these slugs)'] + [f'- {s}: {t}' for s, (t, _) in CONCEPTS.items()]
    lines += ['', f'Models that exist for this capability: {", ".join(MODELS_OF.get(cid, [])) or "none"}']
    return '\n'.join(lines)


def call_model(prompt, model=None):
    env = dict(os.environ)
    env.setdefault('CLAUDE_CONFIG_DIR', os.path.expanduser('~/.claude-personal'))
    env.pop('ANTHROPIC_API_KEY', None)
    cmd = ['claude', '-p', '--tools', '', '--no-session-persistence', '--output-format', 'text'] + (['--model', model] if model else [])
    with tempfile.TemporaryDirectory() as scratch:
        r = subprocess.run(cmd, input=prompt, capture_output=True, text=True, cwd=scratch, env=env, timeout=1500)
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError(f'model call failed: rc={r.returncode} {r.stderr[-300:]}')
    return r.stdout


def clean_answer(text):
    text = text.strip()
    text = re.sub(r'^```(?:markdown|md)?\n', '', text)
    text = re.sub(r'\n```\s*$', '', text)
    m = re.search(r'^---\n', text, re.M)
    return text[m.start():] if m else text


def verify_and_clean(body, tests):
    """Drop every proof and code reference that does not check out. -> (new body, list of removed claims)."""
    removed = []

    def fix_proof(m):
        ids = [x.strip() for x in m.group(1).split(',') if x.strip()]
        keep = [x for x in ids if x == 'none' or x in tests]
        removed.extend(f'proof `{x}` (no test carries it)' for x in ids if x not in keep)
        return f'[proof: {", ".join(keep) if keep else "none"}]'

    def fix_code(m):
        refs = [x.strip() for x in m.group(1).split(',') if x.strip()]
        keep = []
        for r in refs:
            ok, why = common.code_ref_ok(r)
            if ok:
                keep.append(r)
            else:
                removed.append(f'code ref `{r}` ({why})')
        return f'[code: {", ".join(keep)}]' if keep else ''

    body = common.PROOF.sub(fix_proof, body)
    body = common.CODE.sub(fix_code, body)
    body = re.sub(r'[ \t]+\n', '\n', body)
    return body, removed


def assemble(f, answer, head, tests, concept_slugs):
    front, body = common.parse_front(answer)
    cid, info = f['id'], f['info']
    body, removed = verify_and_clean(body, tests)
    concepts = [c for c in front.get('concepts', []) if c in CONCEPTS]
    depends = [d for d in front.get('depends_on', f['spec']['depends']) if d in common.capability_ids() and d != cid]
    models = MODELS_OF.get(cid, [])
    lines = ['---', f'id: {cid}', f'title: {info["title"]}', 'kind: capability', 'status: draft', f'generated_at: {head}',
             f'depends_on: [{", ".join(depends)}]', f'concepts: [{", ".join(concepts)}]', f'models: [{", ".join(models)}]', 'scope:']
    lines += [f'  - {g}' for g in f['glob']]
    lines.append('---')
    page = '\n'.join(lines) + '\n' + body.lstrip('\n')
    if removed:
        page = page.rstrip('\n') + '\n\n### Claims the generator could not verify (removed from the rules above)\n' + '\n'.join(f'- {x}' for x in sorted(set(removed))) + '\n'
    return page, len(removed)


def generate_capability(cid, f, built, head, tests, model, force):
    slug = built[cid]['slug']
    path = os.path.join(common.SPEC, 'capabilities', f'{cid}-{slug}.md')
    if os.path.exists(path) and not force:
        return cid, 'kept (exists; --force regenerates drafts)', 0
    if os.path.exists(path) and common.parse_front(read(path))[0].get('status') != 'draft':
        return cid, 'kept (reviewed)', 0
    prompt = build_prompt(f, built)
    last = None
    for attempt in range(2):
        try:
            answer = clean_answer(call_model(prompt, model))
            if not answer.startswith('---'):
                raise RuntimeError('the answer has no front matter')
            page, removed = assemble(f, answer, head, tests, set(CONCEPTS))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'w', encoding='utf-8') as fh:
                fh.write(page)
            return cid, 'written', removed
        except Exception as e:  # noqa: BLE001
            last = e
    return cid, f'FAILED: {last}', 0


CONCEPT_PROMPT = """You write ONE concept page of a living specification: an idea that several capabilities of a system rely on. A human will review it and keep it as the
truth. You receive facts: the lines of capability pages that mention the concept. Use ONLY those facts; do not add anything you cannot read in them.

Output exactly this, no preamble and no code fence:

# <Title>
## Definition
At most 120 words, in business words: what it is, and the guarantee it gives to the capabilities that use it.
## Rules
Four to eight lines, each a rule that always holds, taken from the facts (merge, do not copy):
- **<slug>.C-01** One sentence of at most 30 words, with MUST, MUST NOT or MAY.
## How the capabilities use it
One bullet per capability that uses it: `- {{cap:S13}} what it relies on or adds`.
## Known gaps
Only if the facts are thin: say what is missing (for example, a defining capability whose page you were not given). Do not pad the page and do not write notes anywhere else.

Style: short active sentences; one word for one thing; no vague words (appropriate, valid, proper, should, handles, supports, some, various); exact names, limits and codes.
"""


def concept_users(cap_pages):
    users = {}
    for pg in cap_pages:
        for slug in CONCEPTS:
            if slug in pg['front'].get('concepts', []) or ('{{concept:%s}}' % slug) in pg['text']:
                users.setdefault(slug, []).append(pg)
    return users


def concept_prompt(slug, title, owner, pages_):
    lines = [CONCEPT_PROMPT, f'# FACTS for the concept "{title}" (slug: {slug}; defined by capability {owner})', '']
    for pg in pages_:
        lines.append(f'## From the page of {pg["front"].get("id")} - {pg["front"].get("title", "")[:70]}')
        hits = [l for l in pg['text'].split('\n') if ('{{concept:%s}}' % slug) in l]
        purpose = re.search(r'^## Purpose\s*\n(.*?)(?=^## )', pg['body'], re.M | re.S)
        if purpose:
            lines.append('Purpose: ' + re.sub(r'\s+', ' ', purpose.group(1))[:500])
        lines += hits[:8] or ['(it is listed as a concept of this capability but no line links it)']
        lines.append('')
    owner_page = next((p_ for p_ in common.pages('capability') if p_['front'].get('id') == owner), None)
    if owner_page:
        lines.append(f'## From the page of {owner} (the capability that defines the concept; read it for the definition)')
        purpose = re.search(r'^## Purpose\s*\n(.*?)(?=^## )', owner_page['body'], re.M | re.S)
        lines.append('Purpose: ' + (re.sub(r'\s+', ' ', purpose.group(1))[:600] if purpose else ''))
        lines += [it['text'][:420] for it in owner_page['items'][:30]]
    return '\n'.join(lines)


def generate_concepts(model, only=None, force=False, jobs=3):
    cap_pages = common.pages('capability')
    users = concept_users(cap_pages)
    work = {s: u for s, u in users.items() if not only or s in only}

    def one(slug):
        title, owner = CONCEPTS[slug]
        path = os.path.join(common.SPEC, 'concepts', f'{slug}.md')
        if os.path.exists(path) and not force and common.parse_front(read(path))[0].get('status') != 'draft':
            return slug, 'kept (reviewed)'
        last = None
        for _ in range(2):
            try:
                body = clean_answer(call_model(concept_prompt(slug, title, owner, work[slug]), model))
                body = body[body.index('# '):] if '# ' in body else body
                body, removed = verify_and_clean(body, {})
                names = ', '.join(f'{{{{cap:{p_["front"]["id"]}}}}} {p_["front"].get("title", "")}' for p_ in work[slug])
                block = '\n'.join(f'- {{{{cap:{p_["front"]["id"]}}}}} {p_["front"].get("title", "")}' for p_ in work[slug])
                page = f"---\nid: {slug}\ntitle: {title}\nkind: concept\nstatus: draft\ndefined_by: {owner}\n---\n" + body.rstrip('\n') + \
                       f"\n\n## Used by\n<!-- used-by:start -->\n{block}\n<!-- used-by:end -->\n"
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, 'w', encoding='utf-8') as fh:
                    fh.write(page)
                return slug, 'written'
            except Exception as e:  # noqa: BLE001
                last = e
        return slug, f'FAILED: {last}'

    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as ex:
        for slug, state in ex.map(one, sorted(work)):
            print(f'concept {slug}: {state}', flush=True)


def build_system():
    caps, cons, mods = common.pages('capability'), common.pages('concept'), common.pages('model')
    import sign as signmod
    lines = ['# System overview', '', '_Generated by `scripts/livespec/generate.py --system`; never edit by hand. The layers and the rules for pages are in [README.md](README.md)._', '',
             f'{len(caps)} capabilities, {len(cons)} shared concepts, {len(mods)} models. A page is `draft` until a human has read and signed it.', '', '## Capabilities']
    cat = common.capability_ids()
    for pg in sorted(caps, key=lambda p: p['front'].get('id', '')):
        cid = pg['front'].get('id', '')
        c = signmod.compare(pg)
        state = 'draft' if c is None else f'{len(c["signed"])}/{len(pg["items"])} items signed' + (', CHANGED since' if c['changed'] or c['removed'] else '')
        lines.append(f'- [{cid}](capabilities/{common.slug_of(pg)}.md) {cat.get(cid, {}).get("title", pg["front"].get("title", ""))[:90]} ({len(pg["items"])} items; {state})')
    lines += ['', '## Dependencies between capabilities', '', '```mermaid', 'graph LR']
    for pg in sorted(caps, key=lambda p: p['front'].get('id', '')):
        for d in pg['front'].get('depends_on', []):
            lines.append(f'    {pg["front"]["id"]} --> {d}')
    lines += ['```', '', '## Shared concepts']
    users = concept_users(caps)
    for pg in sorted(cons, key=lambda p: p['front'].get('id', '')):
        slug = common.slug_of(pg)
        lines.append(f'- [{pg["front"].get("title", slug)}](concepts/{slug}.md): defined by {{{{cap:{pg["front"].get("defined_by", "?")}}}}}; used by {len(users.get(slug, []))} capabilities')
    lines += ['', '## Models']
    for pg in sorted(mods, key=lambda p: p['front'].get('id', '')):
        lines.append(f'- [{pg["front"].get("title", "")}](models/{common.slug_of(pg)}.md) ({pg["front"].get("format", "state machine")})')
    lines += ['', '## Verification', '', '- `python3 scripts/livespec/check.py`: links, proofs, code references, routes, concepts, models, sign-off drift',
              '- `python3 scripts/livespec/models.py check`: state machines against the code', '- `python3 scripts/livespec/run_models.py`: Quint models',
              '- `python3 scripts/livespec/sign.py status`: who reviewed what']
    with open(os.path.join(common.SPEC, 'system.md'), 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lines) + '\n')
    print('system.md written')


def main(argv):
    only = argv[argv.index('--only') + 1].split(',') if '--only' in argv else None
    jobs = int(argv[argv.index('--jobs') + 1]) if '--jobs' in argv else 3
    model = argv[argv.index('--model') + 1] if '--model' in argv else None
    force = '--force' in argv
    built = built_capabilities()
    tests = common.test_index()
    head = sh('rev-parse', '--short', 'HEAD').strip()
    targets = [c for c in built if not only or c in only]
    facts = {c: facts_for(c, built[c], tests) for c in targets}
    stage_only = '--concepts' in argv or '--system' in argv
    if '--concepts' in argv:
        generate_concepts(model, force=force)
    if '--system' in argv:
        build_system()
    if stage_only:
        return 0
    if '--facts' in argv:
        for c, f in facts.items():
            print(f'{c} {built[c]["title"][:50]}: {len(f["spec"]["scenarios"])} scenarios, {len(f["spec"]["frs"])} FRs, {len(f["files"])} files, '
                  f'{len(f["cites"])} test ids, routes {len(f["code"]["routes"])}, events {len(f["code"]["events"])}, queues {len(f["code"]["queues"])}, '
                  f'prompt {len(build_prompt(f, built)) // 1024} KB; scope {f["glob"][:2]}')
        return 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as ex:
        futs = [ex.submit(generate_capability, c, facts[c], built, head, tests, model, force) for c in targets]
        for fu in concurrent.futures.as_completed(futs):
            cid, state, removed = fu.result()
            print(f'{cid}: {state}' + (f' ({removed} unverifiable claims removed)' if removed else ''), flush=True)
    if only:
        missing = {sl for sl in concept_users(common.pages('capability')) if not os.path.exists(os.path.join(common.SPEC, 'concepts', f'{sl}.md'))}
        if missing:
            generate_concepts(model, only=missing, jobs=jobs)
        subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'check.py'), '--fix-backlinks'], capture_output=True)
    else:
        generate_concepts(model, force=force, jobs=jobs)
    build_system()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
