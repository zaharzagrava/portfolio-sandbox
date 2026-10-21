#!/usr/bin/env python3
"""depgraph.py: which files does each backend e2e spec depend on (a plain import crawl, no databases, about a second for all suites).

  depgraph.py specs                      print every e2e spec file (paths relative to packages/backend)
  depgraph.py deps <spec>                print the files the spec imports, directly and through other files
  depgraph.py hash [spec...]             print "<spec>  <hash>" ; the hash covers the spec, every file it imports, and the shared test
                                         infrastructure (see GLOBAL below). No spec given = all of them.
  depgraph.py select <changed path...>   print the specs that need a rerun for these changed files (paths relative to the repo root).
                                         A change in the shared infrastructure prints every spec.

How the crawl works: it reads `import x from '...'`, `export ... from '...'`, `import('...')`, `require('...')` and `jest.requireActual('...')`
and resolves them like the test config does (the @app/... aliases of vitest.e2e.config.ts, @marketplace-sandbox/contracts, relative paths,
index files). Packages from node_modules are not followed (a change of package.json / the lockfile counts as shared infrastructure).
A few data files named by a relative string ('./fixtures/x.json') are followed too. What it cannot see: a file that is read by a path built at
run time. When in doubt, run everything (select-tests.sh FULL=1).
"""
import fnmatch, hashlib, os, re, subprocess, sys

# SPEEDUP_REPO points at another checkout (the tests use a tiny one).
REPO = os.environ.get('SPEEDUP_REPO') or subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True, cwd=os.path.dirname(os.path.abspath(__file__))).stdout.strip()
BACKEND = os.path.join(REPO, 'packages', 'backend')
CONTRACTS = os.path.join(REPO, 'packages', 'contracts')

# The same roots as vitest.e2e.config.ts (`include`).
SPEC_ROOTS = ['libs', 'apps', 'test/toolkit', 'scripts/rag-eval']
# Shared test infrastructure: a change here can change every suite, so it counts as "run everything" and is part of every hash.
# (Paths relative to the repo root; a trailing / means the whole folder.)
GLOBAL = [
    'packages/backend/test/', 'packages/backend/vitest.e2e.config.ts', 'packages/backend/package.json', 'packages/backend/tsconfig.json',
    'packages/backend/migrations/', 'packages/backend/migrations-scheduled/', 'packages/backend/cql/', 'packages/backend/dynamodb/',
    'packages/backend/clickhouse/', 'packages/backend/db/', 'packages/backend/configs/', 'packages/backend/env/',
    'packages/contracts/package.json', 'pnpm-lock.yaml', 'package.json', 'docker-compose.test.yaml',
]
EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json']
SKIP_DIRS = {'node_modules', 'dist', '.git', 'coverage'}

IMPORT_RES = [
    re.compile(r'''\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"\n]+)['"]'''),
    re.compile(r'''\bimport\s*['"]([^'"\n]+)['"]'''),
    re.compile(r'''\b(?:import|require|requireActual|importActual)\s*\(\s*['"]([^'"\n]+)['"]'''),
]
DATA_RE = re.compile(r'''['"](\.{1,2}/[^'"\n]+\.(?:json|sql|csv|graphql|gql|cql|ya?ml|txt|ndjson|md))['"]''')

ALIASES = [
    (re.compile(r'^@app/(infrastructure|composition|domains)/(.*)$'), lambda m: os.path.join(BACKEND, 'libs', m[1], m[2])),
    (re.compile(r'^@app/test/(.*)$'), lambda m: os.path.join(BACKEND, 'test', m[1])),
    (re.compile(r'^@app/common/(.*)$'), lambda m: os.path.join(BACKEND, 'libs', 'common', m[1])),
    (re.compile(r'^@app/(core|bff|sse-gateway|worker|projector|collab|public-api|payment-processor)/(.*)$'), lambda m: os.path.join(BACKEND, 'apps', m[1], 'src', m[2])),
    (re.compile(r'^@marketplace-sandbox/contracts(?:/(.*))?$'), lambda m: os.path.join(CONTRACTS, m[1] or 'index')),
]


def try_file(base):
    if os.path.isfile(base) and os.path.splitext(base)[1] in EXTS + ['.sql']:
        return base
    stem = base[:-3] if base.endswith('.js') else base   # the jest/vitest map strips a trailing .js
    for cand in [stem + e for e in EXTS] + [os.path.join(base, 'index' + e) for e in EXTS]:
        if os.path.isfile(cand):
            return cand
    return None


def resolve(spec, from_file):
    if spec.startswith('.'):
        return try_file(os.path.normpath(os.path.join(os.path.dirname(from_file), spec)))
    for rx, fn in ALIASES:
        m = rx.match(spec)
        if m:
            return try_file(os.path.normpath(fn(m)))
    return None


_direct = {}


def direct_deps(path):
    if path in _direct:
        return _direct[path]
    out = set()
    _direct[path] = out
    if path.endswith(('.ts', '.tsx', '.js', '.mjs', '.cjs')):
        try:
            text = open(path, encoding='utf-8', errors='replace').read()
        except OSError:
            return out
        for rx in IMPORT_RES:
            for m in rx.finditer(text):
                r = resolve(m.group(1), path)
                if r:
                    out.add(r)
        for m in DATA_RE.finditer(text):
            p = os.path.normpath(os.path.join(os.path.dirname(path), m.group(1)))
            if os.path.isfile(p):
                out.add(p)
    return out


def closure(spec_abs):
    seen, stack = set(), [spec_abs]
    while stack:
        f = stack.pop()
        if f in seen:
            continue
        seen.add(f)
        stack.extend(direct_deps(f) - seen)
    return seen


def all_specs():
    out = []
    for root in SPEC_ROOTS:
        for d, dirs, files in os.walk(os.path.join(BACKEND, root)):
            dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
            out += [os.path.relpath(os.path.join(d, f), BACKEND) for f in files if f.endswith('.e2e-spec.ts')]
    return sorted(set(out))


def is_global(rel_repo_path):
    return any(rel_repo_path == g or (g.endswith('/') and rel_repo_path.startswith(g)) for g in GLOBAL)


def global_files():
    out = []
    for g in GLOBAL:
        p = os.path.join(REPO, g)
        if g.endswith('/'):
            for d, dirs, files in os.walk(p):
                dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
                out += [os.path.join(d, f) for f in files]
        elif os.path.isfile(p):
            out.append(p)
    return sorted(out)


def file_digest(p, cache={}):
    if p not in cache:
        try:
            cache[p] = hashlib.sha1(open(p, 'rb').read()).hexdigest()
        except OSError:
            cache[p] = 'missing'
    return cache[p]


_global_digest = []


def global_digest():
    if not _global_digest:
        h = hashlib.sha1()
        for p in global_files():
            h.update((os.path.relpath(p, REPO) + ':' + file_digest(p) + '\n').encode())
        _global_digest.append(h.hexdigest())
    return _global_digest[0]


def spec_hash(spec_rel):
    h = hashlib.sha1(global_digest().encode())
    for p in sorted(closure(os.path.join(BACKEND, spec_rel))):
        h.update((os.path.relpath(p, REPO) + ':' + file_digest(p) + '\n').encode())
    return h.hexdigest()


def select(changed):
    changed = [c.strip() for c in changed if c.strip()]
    specs = all_specs()
    if any(is_global(c) for c in changed):
        return specs
    abs_changed = {os.path.join(REPO, c) for c in changed}
    return [s for s in specs if closure(os.path.join(BACKEND, s)) & abs_changed]


def main(argv):
    cmd, args = (argv[0] if argv else ''), argv[1:]
    if cmd == 'specs':
        print('\n'.join(all_specs()))
    elif cmd == 'deps':
        print('\n'.join(sorted(os.path.relpath(p, BACKEND) for p in closure(os.path.join(BACKEND, args[0])))))
    elif cmd == 'hash':
        for s in (args or all_specs()):
            print(f'{s}\t{spec_hash(s)}')
    elif cmd == 'select':
        print('\n'.join(select(args)))
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except BrokenPipeError:
        sys.exit(0)
