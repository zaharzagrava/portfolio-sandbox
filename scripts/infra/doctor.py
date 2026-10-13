#!/usr/bin/env python3
"""doctor.py: the static half of the infrastructure doctor. Lists every queue, topic, bucket and table the backend code uses and checks that
the local stack defines it. Nothing is started or contacted; it only reads files (so it runs without Docker).

  python3 scripts/infra/doctor.py                    # every item, OK or MISSING; exit 1 if any is missing
  python3 scripts/infra/doctor.py --missing-only     # only what is missing, and the counts
  python3 scripts/infra/doctor.py --only queues,topics
  python3 scripts/infra/doctor.py --root DIR         # another project root (the tests use a throwaway one)

What counts as "used" (code under packages/backend/libs and apps, without tests, test helpers and comments):
  queues   a constant or property named like QUEUE with a string value, `queue: '...'`, `.enqueue/.enqueueBatch/.consume('...')`, `deadLetterQueue`,
           and the values of an object named like QUEUES. Each queue also needs its dead-letter queue (`<name>-dlq`, `<name>-dlq.fifo` for a .fifo queue).
  topics   a string like `orders.events`, the aggregate type of `defineEvent('type', 'orders', ...)`, of a topic registration, or of `aggregateType: 'orders'`
           (the outbox publishes to `<aggregateType>.events`).
  buckets  `*BUCKET*=value` in packages/backend/env/*.example, and a default after `config.get('..bucket..') ??`.
  tables   Postgres: `tableName: 'X'` in the models; DynamoDB: `.table('X')` and `*TABLE* = 'X'` in files that use Dynamo; Cassandra: FROM/INTO/UPDATE
           in files that use Cassandra. (ClickHouse is not covered yet.)
What counts as "defined":
  queues   infra/docker/elasticmq/elasticmq.conf (and both compose files must mount it)
  topics   packages/backend/scripts/init-kafka-topics.sh (and `rpk topic create` anywhere in scripts), or auto-creation switched on in a compose file
  buckets  `mc mb` lines of the compose files (an env example is checked against its own stack: showcase -> docker-compose.yaml, test -> docker-compose.test.yaml)
  tables   packages/backend/migrations (createTable and CREATE TABLE), dynamodb/*.json, cql/*.cql
Limits: lexical, not a parse of the TypeScript. A name built at run time (a template string) is invisible, so a clean run is not proof; a MISSING line is a lead,
read the file it names. The dynamic half (is the broker really up, is the queue really there, is /health/ready honest) needs the stack and is not here."""
import argparse
import glob
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
BACKEND = 'packages/backend'
SOURCE_DIRS = ('libs', 'apps')
SKIP_DIRS = {'node_modules', 'dist', 'testing', 'test', '__mocks__', '.git'}
SKIP_SUFFIXES = ('.spec.ts', '.e2e-spec.ts', '.journey-spec.ts', '.test.ts', '.d.ts')
ELASTICMQ = 'infra/docker/elasticmq/elasticmq.conf'
COMPOSE = ('docker-compose.yaml', 'docker-compose.test.yaml')
ENV_STACK = {'showcase.env.example': 'docker-compose.yaml', 'test.env.example': 'docker-compose.test.yaml'}
KINDS = ('queues', 'topics', 'buckets', 'tables')


def read(path):
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            return f.read()
    except OSError:
        return ''


def strip_comments(src):
    """Replaces comments by spaces (newlines kept, so line numbers stay true). `//` inside a URL is not a comment."""
    src = re.sub(r'/\*.*?\*/', lambda m: re.sub(r'[^\n]', ' ', m.group(0)), src, flags=re.S)
    return re.sub(r'(^|(?<=[\s;,{}()]))//[^\n]*', lambda m: re.sub(r'[^\n]', ' ', m.group(0)), src, flags=re.M)


def source_files(root):
    out = []
    for sub in SOURCE_DIRS:
        base = os.path.join(root, BACKEND, sub)
        for d, dirs, files in os.walk(base):
            dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
            for f in sorted(files):
                if f.endswith('.ts') and not f.endswith(SKIP_SUFFIXES):
                    out.append(os.path.join(d, f))
    return out


class Collector:
    """name -> list of 'relative/file.ts:line' where it is used."""

    def __init__(self, root):
        self.root = root
        self.items = {}

    def add(self, name, path, src, pos):
        line = src.count('\n', 0, pos) + 1
        loc = f'{os.path.relpath(path, self.root)}:{line}'
        locs = self.items.setdefault(name, [])
        if loc not in locs:
            locs.append(loc)


def scan(root, patterns, only_if=None):
    """patterns: list of (compiled regex, group index or None for 'all quoted values in group 1'). Returns Collector."""
    c = Collector(root)
    for path in source_files(root):
        raw = read(path)
        if only_if and not re.search(only_if, raw):
            continue
        src = strip_comments(raw)
        for rx, mode in patterns:
            for m in rx.finditer(src):
                if mode == 'values':
                    for v in re.finditer(r"'([^'\s]+)'", m.group(1)):
                        c.add(v.group(1), path, src, m.start(1) + v.start(1))
                else:
                    c.add(m.group(1), path, src, m.start(1))
    return c


# ---- queues
QNAME = r"([a-z0-9][a-z0-9-]*(?:\.fifo)?)"
QUEUE_PATTERNS = [
    (re.compile(r"\b(?:const|let|var)\s+[A-Za-z_]*QUEUE[A-Za-z_]*\s*(?::[^=;]+)?=\s*'" + QNAME + "'"), None),
    (re.compile(r"\bqueue\s*:\s*'" + QNAME + "'"), None),
    (re.compile(r"\.(?:enqueue|enqueueBatch|consume)\(\s*'" + QNAME + "'"), None),
    (re.compile(r"\bdeadLetterQueue\s*:\s*'" + QNAME + "'"), None),
    (re.compile(r"\b[A-Za-z_]*QUEUES[A-Za-z_]*\s*(?::[^=;]+)?=\s*\{([^}]*)\}"), 'values'),
]


def dlq_of(queue):
    return (queue[:-5] + '-dlq.fifo') if queue.endswith('.fifo') else queue + '-dlq'


def parse_elasticmq(text):
    """Top-level names of the `queues { ... }` block (a name followed by `{`, at depth 0 inside the block)."""
    text = re.sub(r'#[^\n]*|//[^\n]*', '', text)
    m = re.search(r'\bqueues\s*\{', text)
    if not m:
        return set()
    body, depth, names, prev = text[m.end():], 0, set(), None
    for t in re.finditer(r'"([^"]+)"|([A-Za-z0-9_.\-]+)|([{}=])', body):
        quoted, word, sym = t.groups()
        if sym == '{':
            if depth == 0 and prev:
                names.add(prev)
            depth += 1
        elif sym == '}':
            if depth == 0:
                break
            depth -= 1
        elif sym is None:
            prev = quoted or word
        if sym == '=':
            prev = None
    return names


def check_queues(root):
    used = scan(root, QUEUE_PATTERNS).items
    path = os.path.join(root, ELASTICMQ)
    defined = parse_elasticmq(read(path))
    res = []
    for q in sorted(used):
        res.append(('queue', q, used[q], q in defined, f'not defined in {ELASTICMQ}'))
        if not (q.endswith('-dlq') or q.endswith('-dlq.fifo')):
            d = dlq_of(q)
            res.append(('queue', d, [f'dead-letter queue of {q}'], d in defined, f'not defined in {ELASTICMQ} (every queue is created with a dead-letter queue)'))
    for f in COMPOSE:
        text = read(os.path.join(root, f))
        if re.search(r'image:\s*\S*elasticmq', text):
            res.append(('stack', f'{f} mounts elasticmq.conf', [f], 'elasticmq.conf' in text, f'the elasticmq service of {f} does not mount {ELASTICMQ}, so no queue exists'))
    if not defined:
        res.append(('stack', ELASTICMQ, [ELASTICMQ], False, 'no queues could be read from this file'))
    return res


# ---- topics
TOPIC_PATTERNS = [
    (re.compile(r"'([a-z][a-z0-9_]*\.(?:events|requests|responses|dlq))'"), None),
    (re.compile(r"\bdefineEvent\(\s*'[^']*'\s*,\s*'([a-z][a-z0-9_]*)'"), 'agg'),
    (re.compile(r"\b(?:register|ensure)\(\s*\{\s*aggregateType\s*:\s*'([a-z][a-z0-9_]*)'"), 'agg'),
    (re.compile(r"\baggregateType\s*:\s*'([a-z][a-z0-9_]*)'"), 'agg'),
]


def used_topics(root):
    items = {}
    for rx, mode in TOPIC_PATTERNS:
        sub = scan(root, [(rx, None)]).items
        for name, locs in sub.items():
            if mode == 'agg':
                name = f'{name}.events'
            cur = items.setdefault(name, [])
            cur += [x for x in locs if x not in cur]
    return items


def defined_topics(root):
    names, auto = set(), []
    scripts = glob.glob(os.path.join(root, BACKEND, 'scripts', '*.sh')) + glob.glob(os.path.join(root, 'scripts', 'infra', '*.sh'))
    for s in scripts:
        text = read(s)
        for m in re.finditer(r'\bTOPICS=\(([^)]*)\)', text, re.S):
            names |= set(re.findall(r'"([^"\s]+)"|\'([^\'\s]+)\'', m.group(1)) and [a or b for a, b in re.findall(r'"([^"\s]+)"|\'([^\'\s]+)\'', m.group(1))])
        names |= set(re.findall(r'rpk topic create\s+["\']?([A-Za-z0-9._-]+)', text))
    for f in COMPOSE:
        if re.search(r'auto_create_topics_enabled[=:\s]+true', read(os.path.join(root, f))):
            auto.append(f)
    return names, auto


def check_topics(root):
    used = used_topics(root)
    names, auto = defined_topics(root)
    res = []
    where = f'{BACKEND}/scripts/init-kafka-topics.sh'
    for t in sorted(used):
        ok = t in names or bool(auto)
        res.append(('topic', t, used[t], ok, f'not created by {where} or any `rpk topic create` in scripts/, and no compose file switches topic auto-creation on (Redpanda creates no topic on first use unless auto_create_topics_enabled is set)'))
    return res


# ---- buckets
def check_buckets(root):
    res = []
    for env in sorted(glob.glob(os.path.join(root, BACKEND, 'env', '*.example'))):
        base = os.path.basename(env)
        for i, line in enumerate(read(env).split('\n'), 1):
            m = re.match(r'\s*([A-Z0-9_]*BUCKET[A-Z0-9_]*)\s*=\s*(\S+)', line)
            if not m:
                continue
            stacks = [ENV_STACK[base]] if base in ENV_STACK else list(COMPOSE)
            made = set()
            for f in stacks:
                made |= set(re.findall(r'mc mb[^\n]*?\blocal/([A-Za-z0-9._-]+)', read(os.path.join(root, f))))
            res.append(('bucket', m.group(2), [f'{BACKEND}/env/{base}:{i} ({m.group(1)})'], m.group(2) in made,
                        f'not created by an `mc mb` line of {" / ".join(stacks)}'))
    dev = set(re.findall(r'mc mb[^\n]*?\blocal/([A-Za-z0-9._-]+)', read(os.path.join(root, COMPOSE[0]))))
    defaults = scan(root, [(re.compile(r"\.get\(\s*'[a-z_]*bucket[a-z_]*'\s*\)\s*\?\?\s*'([^']+)'"), None)]).items
    for b in sorted(defaults):
        res.append(('bucket', b, defaults[b], b in dev, f'the code default when the bucket variable is unset; not created by an `mc mb` line of {COMPOSE[0]}'))
    return res


# ---- tables
def migration_tables(root):
    names = set()
    for f in glob.glob(os.path.join(root, BACKEND, 'migrations', '*.js')):
        text = read(f)
        names |= set(re.findall(r"createTable\(\s*['\"`]([A-Za-z_][A-Za-z0-9_]*)['\"`]", text))
        names |= {m.group(1) for m in re.finditer(r'CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?', text, re.I)}
    return names


def check_tables(root):
    res = []
    models = scan(root, [(re.compile(r"\btableName\s*:\s*'([A-Za-z_][A-Za-z0-9_]*)'"), None)]).items
    have = migration_tables(root)
    for t in sorted(models):
        res.append(('table', f'postgres {t}', models[t], t in have, f'no createTable or CREATE TABLE in {BACKEND}/migrations'))
    dyn = scan(root, [(re.compile(r"\.table\(\s*'([A-Za-z][A-Za-z0-9_]*)'\s*\)"), None),
                      (re.compile(r"\b[A-Z_]*TABLE[A-Z_]*\s*(?::[^=;]+)?=\s*'([A-Za-z][A-Za-z0-9_]*)'"), None)], only_if=r'(?i)dynamo').items
    dhave = set()
    for f in glob.glob(os.path.join(root, BACKEND, 'dynamodb', '*.json')):
        try:
            dhave.add(json.loads(read(f)).get('TableName'))
        except ValueError:
            pass
    for t in sorted(dyn):
        res.append(('table', f'dynamodb {t}', dyn[t], t in dhave, f'no {BACKEND}/dynamodb/*.json with that TableName'))
    cas = scan(root, [(re.compile(r"\b(?:FROM|INTO|UPDATE)\s+(?!system)(?:[a-z_]+\.)?([a-z][a-z0-9_]*)\b"), None)], only_if=r'(?i)cassandra').items
    chave = set()
    for f in glob.glob(os.path.join(root, BACKEND, 'cql', '*.cql')):
        chave |= {m.group(1) for m in re.finditer(r'CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[a-z_]+\.)?([a-z][a-z0-9_]*)', read(f), re.I)}
    for t in sorted(cas):
        res.append(('table', f'cassandra {t}', cas[t], t in chave, f'no CREATE TABLE in {BACKEND}/cql'))
    return res


CHECKS = {'queues': check_queues, 'topics': check_topics, 'buckets': check_buckets, 'tables': check_tables}


def run(root, only=KINDS):
    out = {}
    for k in only:
        out[k] = CHECKS[k](root)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=ROOT)
    ap.add_argument('--missing-only', action='store_true')
    ap.add_argument('--only', default=','.join(KINDS))
    a = ap.parse_args(argv)
    only = [k for k in a.only.split(',') if k]
    bad = [k for k in only if k not in KINDS]
    if bad:
        print(f'unknown kind: {", ".join(bad)} (known: {", ".join(KINDS)})', file=sys.stderr)
        return 2
    results = run(a.root, only)
    missing = 0
    for kind in only:
        rows = results[kind]
        miss = [r for r in rows if not r[3]]
        missing += len(miss)
        print(f'{kind}: {len(rows)} checked, {len(miss)} missing')
        for typ, name, locs, ok, why in rows:
            if ok and a.missing_only:
                continue
            first = locs[0] if locs else ''
            more = f' (+{len(locs) - 1} more)' if len(locs) > 1 else ''
            print(f'  {"OK     " if ok else "MISSING"} {typ} {name}   used in {first}{more}' + ('' if ok else f'\n          -> {why}'))
    print(f'{"FAILED" if missing else "OK"}: {missing} item{"s" if missing != 1 else ""} missing')
    return 1 if missing else 0


if __name__ == '__main__':
    sys.exit(main())
