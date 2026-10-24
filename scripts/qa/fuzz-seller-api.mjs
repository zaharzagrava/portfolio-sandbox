#!/usr/bin/env node
// Sends strange requests to every seller endpoint of the API as a brand-new seller and checks a few rules that must always hold.
//   node scripts/qa/fuzz-seller-api.mjs [--minutes 5] [--seed N] [--api http://localhost:8000] [--delay-ms 25]
// The API serves no OpenAPI document for the seller area (only the public developer API has one), so the endpoint list is read
// from the controllers in packages/backend (the @Controller / @Get / @Post ... lines). Notes in plain words: docs/work/speedup-notes/qa-monkey-fuzz.md
// Rules checked after every answer: never 5xx; every 4xx is a problem+json document with a stable "code"; no stack trace, SQL or file
// path in any body; a call without a login answers 401; a call with another seller's ids answers 403/404 and shows nothing of theirs;
// the same create sent again with one Idempotency-Key makes one thing, not two.
// Result: specs/.checkpoints/qa-fuzz/<timestamp>/findings.tsv (+ login.sh to set TOKEN for the curl lines, + requests.log).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
if (args.includes('-h') || args.includes('--help')) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).join('\n')); process.exit(0); }
const MINUTES = Number(opt('minutes', 5));
const SEED = Number(opt('seed', Date.now() % 1e9));
const API = opt('api', process.env.API_URL ?? 'http://localhost:8000');
const DELAY = Number(opt('delay-ms', 25));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.join(ROOT, 'specs/.checkpoints/qa-fuzz', STAMP);
fs.mkdirSync(OUT, { recursive: true });
const DEADLINE = Date.now() + MINUTES * 60_000;
const PASSWORD = 'SuperSecurePassword123!';

// small seeded random generator, so --seed repeats the same order
let s = SEED >>> 0;
const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => '01a16dfb-6cf5-7449-8233-' + String(Math.floor(rnd() * 1e12)).padStart(12, '0');

// ---------- the endpoint list, read from the controllers ----------
function scanRoutes() {
  const out = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (f.name === 'node_modules') continue;
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/controller\.ts$/.test(f.name)) {
        const src = fs.readFileSync(p, 'utf8');
        const m = src.match(/@Controller\(\s*(?:['"]([^'"]*)['"])?/);
        if (!m) continue;
        for (const r of src.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:['"]([^'"]*)['"])?\s*\)/g)) {
          const route = '/api/' + [m[1], r[2]].filter(Boolean).join('/').replace(/\/+/g, '/');
          out.push({ method: r[1].toUpperCase(), route, file: f.name });
        }
      }
    }
  };
  for (const d of ['libs', 'apps']) walk(path.join(ROOT, 'packages/backend', d));
  const seen = new Set();
  return out.filter((e) => {
    const k = e.method + ' ' + e.route;
    if (seen.has(k)) return false; seen.add(k);
    if (/\/api\/(admin|finance|dev|internal|v1)\b/.test(e.route)) return false;   // not seller endpoints
    if (/auth\/(logout|delete|password|mfa)|\/me\b|account/.test(e.route)) return false;   // account-level: never touched
    return /:shopId|\/shops\b|\/shops\/mine|\/media\b|\/seller\//.test(e.route) && !/\/shops\/:shopId\/(invites|members)\/.*(owner)/.test(e.route);
  });
}

// ---------- calling the API ----------
let TOKEN = '';
const stats = { requests: 0, limited: 0 };
const log = fs.createWriteStream(path.join(OUT, 'requests.log'));
async function call(method, url, { body, token = TOKEN, headers = {}, raw } = {}) {
  const h = { ...(token && { authorization: `Bearer ${token}` }), ...headers };
  let payload;
  if (raw !== undefined) { payload = raw; h['content-type'] ??= 'application/json'; }
  else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] ??= 'application/json'; }
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(DELAY);
    let res, text = '';
    try { res = await fetch(API + url, { method, headers: h, body: ['GET', 'HEAD'].includes(method) ? undefined : payload, signal: AbortSignal.timeout(20_000) }); text = await res.text(); }
    catch (e) { return { status: 0, text: String(e), ctype: '', json: undefined, error: true, payload }; }
    stats.requests++;
    log.write(`${method} ${url} ${payload ? payload.slice(0, 200) : ''} -> ${res.status}\n`);
    if (res.status === 429) { stats.limited++; await sleep(Math.min(8000, (Number(res.headers.get('retry-after')) || 2) * 1000)); continue; }
    let json; try { json = text ? JSON.parse(text) : undefined; } catch { /* not json */ }
    return { status: res.status, text, ctype: res.headers.get('content-type') ?? '', json, payload };
  }
  return { status: 429, text: '', ctype: '', json: undefined, payload };
}

// ---------- findings ----------
const findings = new Map();
const esc = (v) => String(v).replace(/[\t\r\n]+/g, ' ').slice(0, 400);
function curlLine(method, url, r, extra = '') {
  const b = r?.payload && !['GET', 'HEAD'].includes(method) ? ` -H 'content-type: application/json' --data-raw '${String(r.payload).slice(0, 2000).replace(/'/g, `'\\''`)}'` : '';
  return `curl -s -i -X ${method} '${API}${url}' -H "authorization: Bearer $TOKEN"${extra}${b}`;
}
function finding(endpoint, mutation, status, why, method, url, r, extra) {
  const key = [endpoint, mutation.replace(/\d{4,}/g, 'N'), why].join('|');
  if (findings.has(key)) { findings.get(key).count++; return; }
  findings.set(key, { endpoint, mutation, status, why, curl: curlLine(method, url, r, extra), count: 1 });
}
const LEAK = [
  [/\bat [\w$.<>]+ \([^)]*\.(js|ts):\d+/, 'stack trace'],
  [/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[^"]{0,80}\b(FROM|VALUES|SET|WHERE)\b/i, 'SQL text'],
  [/(PrismaClient|QueryFailedError|SequelizeDatabaseError|syntax error at or near|relation "[\w.]+" does not exist|ScyllaDB|cassandra|ECONNREFUSED|TypeError:|ReferenceError:)/i, 'internal error text'],
  [/(\/home\/[\w.-]+\/|\/usr\/src\/|\/app\/(src|dist|node_modules)|node_modules\/|[A-Z]:\\\\Users)/, 'file path'],
];
function check(method, tmpl, url, mutation, r, { expectStatus, foreign, extra } = {}) {
  const ep = `${method} ${tmpl}`;
  if (r.error) return finding(ep, mutation, 0, 'request failed or timed out (20 s): ' + r.text, method, url, r, extra);
  if (r.status === 429) return;
  if (r.status >= 500) finding(ep, mutation, r.status, 'server error (5xx)', method, url, r, extra);
  if (r.status >= 400 && r.status < 500) {
    if (!/application\/problem\+json/.test(r.ctype)) finding(ep, mutation, r.status, `4xx is not application/problem+json (is "${r.ctype.split(';')[0] || 'none'}")`, method, url, r, extra);
    else if (!r.json || typeof r.json.code !== 'string' || !/^[a-z][a-z0-9_]*$/.test(r.json.code)) finding(ep, mutation, r.status, 'problem+json without a stable "code"', method, url, r, extra);
  }
  for (const [re, name] of LEAK) if (re.test(r.text)) finding(ep, mutation, r.status, `body leaks ${name}: ${(r.text.match(re) ?? [''])[0].slice(0, 80)}`, method, url, r, extra);
  if (expectStatus && !expectStatus.includes(r.status)) finding(ep, mutation, r.status, `expected ${expectStatus.join('/')} but got ${r.status}`, method, url, r, extra);
  if (foreign && r.status < 400) finding(ep, mutation, r.status, 'another seller\'s id answered success', method, url, r, extra);
  const unechoed = r.text.split(url.split('?')[0]).join('');   // an error may repeat the asked path (the "instance" member): that is not a leak
  if (foreign) for (const secret of foreign) if (secret && unechoed.includes(secret)) finding(ep, mutation, r.status, `another seller's data in the answer (${secret.slice(0, 24)})`, method, url, r, extra);
}

// ---------- fresh sellers ----------
async function newSeller(tag) {
  const email = `fuzz-${tag}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e5).toString(36)}@example.com`;
  const c = await call('POST', '/api/auth/register', { body: { email, password: PASSWORD }, token: '' });
  if (c.status >= 300) throw new Error(`register ${email}: ${c.status} ${c.text.slice(0, 300)}`);
  const l = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD }, token: '' });
  if (l.status !== 200) throw new Error(`login ${email}: ${l.status} ${l.text.slice(0, 300)}`);
  const token = l.json.accessToken.token;
  const slug = `fuzz-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const shop = await call('POST', '/api/shops', { body: { name: `Fuzz ${tag} ${slug}`, slug }, token });
  if (shop.status !== 201) throw new Error(`open shop: ${shop.status} ${shop.text.slice(0, 300)}`);
  const prod = await call('POST', `/api/shops/${shop.json.id}/products`, { token, body: productBody(`Fuzz item ${tag} ${slug}`) });
  return { email, token, shopId: shop.json.id, shopName: shop.json.name, productId: prod.status === 201 ? prod.json.id : undefined, productTitle: `Fuzz item ${tag} ${slug}` };
}
const productBody = (title) => ({ title, brand: 'Test', category: 'fuzz', quantity: 5, priceMinor: 1999, description: `${title}. Made by the fuzzer.`, tags: ['fuzz'] });

// Valid bodies that are known; every other write starts from {} (the API's own error answers then name the missing fields).
const VALID = {
  'POST /api/shops/:shopId/products': () => productBody('Fuzz made ' + Math.floor(rnd() * 1e6)),
  'PATCH /api/shops/:shopId/products/:productId': () => ({ title: 'Fuzz renamed ' + Math.floor(rnd() * 1e6) }),
  'PATCH /api/shops/:shopId': () => ({ description: 'A shop made by the fuzzer.' }),
  'POST /api/shops/:shopId/developers/webhooks': () => ({ url: 'https://example.com/hook', eventTypes: ['order.created'] }),
  'POST /api/shops/:shopId/developers/keys': () => ({ name: 'fuzz key', scopes: ['products:read'] }),
  'POST /api/shops/:shopId/invites': () => ({ email: `invitee-${Math.floor(rnd() * 1e9)}@example.com`, role: 'staff' }),
  'POST /api/shops/:shopId/pickup-points': () => ({ name: 'Fuzz point' }),
};

const HUGE = 'A'.repeat(100_000);
function mutateValue(v) {
  const bad = [null, true, false, 0, -1, 1.5, -1e9, 2 ** 53, 9007199254740993, 1e308, '', ' ', HUGE, '😀🧑‍🚀 日本語 ‮RTL‬ \u0000 \ud800', '<script>alert(1)</script>', "'; DROP TABLE products; --", '{{7*7}} ${7*7}', '../../etc/passwd', [], [[]], {}, { a: { b: 1 } }, Array(500).fill('x'), 'NaN', 'Infinity', '9'.repeat(40)];
  return pick(bad);
}
function bodyMutations(base) {
  const out = [];
  if (base && typeof base === 'object') {
    const keys = Object.keys(base);
    for (const k of keys) {
      out.push([`field ${k} removed`, (() => { const b = { ...base }; delete b[k]; return b; })()]);
      for (let i = 0; i < 3; i++) { const v = mutateValue(); out.push([`field ${k} = ${esc(JSON.stringify(v)).slice(0, 40)}`, { ...base, [k]: v }]); }
    }
    out.push(['extra fields', { ...base, isAdmin: true, role: 'owner', shopId: uuid(), id: uuid(), __proto__: { polluted: 1 }, constructor: { prototype: { x: 1 } } }]);
    out.push(['all fields null', Object.fromEntries(keys.map((k) => [k, null]))]);
  }
  out.push(['empty object', {}], ['null body', null], ['array body', [1, 2, 3]], ['string body', 'hello'], ['number body', 12345]);
  out.push(['huge object', Object.fromEntries(Array.from({ length: 2000 }, (_, i) => ['k' + i, i]))]);
  out.push(['deeply nested', (() => { let o = {}; const root = o; for (let i = 0; i < 400; i++) { o.a = {}; o = o.a; } return root; })()]);
  return out;
}

async function main() {
  console.log(`fuzz-seller-api: seed ${SEED}, ${MINUTES} min, api ${API}, output ${path.relative(ROOT, OUT)}`);
  const routes = scanRoutes();
  console.log(`${routes.length} seller endpoints found in the controllers`);
  const A = await newSeller('a'), B = await newSeller('b');
  TOKEN = A.token;
  fs.writeFileSync(path.join(OUT, 'login.sh'), `# source this, then run the curl lines of findings.tsv (the token lasts a short time; fresh sellers are made on every run)\nexport TOKEN='${A.token}'\n# seller A: shop ${A.shopId}, product ${A.productId}; seller B (the "other" seller): shop ${B.shopId}, product ${B.productId}\n`);
  const foreignSecrets = [B.shopId, B.shopName, B.productId, B.productTitle, B.email].filter(Boolean);
  const subst = (r, who, other) => r.replace(':shopId', who.shopId).replace(':productId', who.productId ?? uuid()).replace(/:[A-Za-z]+/g, () => uuid());

  // the order is random but repeatable; each pass over the list tries one more kind of trouble
  const order = shuffle(routes);
  const done = { calls: 0, endpoints: new Set() };
  const phase = async (name, fn) => {
    for (const e of order) {
      if (Date.now() > DEADLINE) return;
      try { await fn(e); } catch (err) { finding(`${e.method} ${e.route}`, name, 0, 'fuzzer crashed on this endpoint: ' + err.message, e.method, e.route, null); }
      done.endpoints.add(e.method + ' ' + e.route);
    }
  };

  // 1. plain calls with a valid-ish body, own ids; 2. no login; 3. another seller's ids; 4. wrong methods
  await phase('valid', async (e) => {
    const url = subst(e.route, A, B); const body = VALID[`${e.method} ${e.route}`]?.() ?? ((e.method === 'GET' || e.method === 'DELETE') ? undefined : {});
    const r = await call(e.method, url, { body }); check(e.method, e.route, url, 'valid request', r);
  });
  await phase('no login', async (e) => {
    const url = subst(e.route, A, B); const r = await call(e.method, url, { token: '', body: e.method === 'GET' || e.method === 'DELETE' ? undefined : {} });
    check(e.method, e.route, url, 'no login', r, { expectStatus: [401], extra: '' });
    const r2 = await call(e.method, url, { token: 'not.a.token', body: e.method === 'GET' || e.method === 'DELETE' ? undefined : {} });
    check(e.method, e.route, url, 'garbage token', r2, { expectStatus: [401] });
  });
  await phase('other seller', async (e) => {
    if (!/:shopId/.test(e.route)) return;
    const mine = e.route.replace(':shopId', B.shopId).replace(':productId', B.productId ?? uuid()).replace(/:[A-Za-z]+/g, () => uuid());   // A's token, B's shop
    const body = e.method === 'GET' || e.method === 'DELETE' ? undefined : (VALID[`${e.method} ${e.route}`]?.() ?? {});
    check(e.method, e.route, mine, "other seller's shop in the path", await call(e.method, mine, { body }), { foreign: foreignSecrets });
    if (/:productId/.test(e.route)) {   // A's shop, B's product
      const u2 = e.route.replace(':shopId', A.shopId).replace(':productId', B.productId ?? uuid()).replace(/:[A-Za-z]+/g, () => uuid());
      check(e.method, e.route, u2, "other seller's product under my shop", await call(e.method, u2, { body }), { foreign: foreignSecrets });
    }
  });
  await phase('wrong method', async (e) => {
    const url = subst(e.route, A, B); const known = new Set(routes.filter((x) => x.route === e.route).map((x) => x.method));
    for (const m of ['PUT', 'PATCH', 'DELETE', 'POST', 'GET'].filter((x) => !known.has(x)).slice(0, 2)) {
      const r = await call(m, url, { body: m === 'GET' || m === 'DELETE' ? undefined : {} }); check(m, e.route, url, 'wrong method', r, { expectStatus: [404, 405] });
    }
  });

  // 5. strange bodies and strange query strings, until the time is up (random picks, repeatable by --seed)
  const writers = order.filter((e) => ['POST', 'PUT', 'PATCH'].includes(e.method));
  const readers = order.filter((e) => e.method === 'GET');
  let round = 0;
  while (Date.now() < DEADLINE) {
    round++;
    for (const e of shuffle(writers)) {
      if (Date.now() > DEADLINE) break;
      const url = subst(e.route, A, B); const base = VALID[`${e.method} ${e.route}`]?.();
      const muts = shuffle(bodyMutations(base)).slice(0, 4);
      for (const [name, body] of muts) {
        const r = await call(e.method, url, { body }); check(e.method, e.route, url, name, r);
      }
      if (rnd() < 0.3) { const r = await call(e.method, url, { raw: '{"a":', headers: {} }); check(e.method, e.route, url, 'broken JSON', r); }
      if (rnd() < 0.2) { const r = await call(e.method, url, { raw: 'a=b', headers: { 'content-type': 'application/x-www-form-urlencoded' } }); check(e.method, e.route, url, 'form content type', r); }
    }
    for (const e of shuffle(readers)) {
      if (Date.now() > DEADLINE) break;
      const base = subst(e.route, A, B);
      const q = pick(['?limit=-1', '?limit=0', '?limit=99999999', '?limit=abc', '?cursor=%00%ff', '?cursor=' + 'z'.repeat(5000), '?page=-3&pageSize=1e9', '?q=' + encodeURIComponent("' OR 1=1 --"), '?sort=;drop', '?from=9999-99-99&to=-1', '?status[]=a&status[]=b', '?a=1&a=2&a=3']);
      const r = await call('GET', base + q); check('GET', e.route, base + q, 'query ' + q.slice(0, 40), r);
      const bad = e.route.replace(/:[A-Za-z]+/g, () => pick(['not-a-uuid', '0', '-1', 'x'.repeat(3000), '%00', '日本語', '../..', '<script>']));
      const r2 = await call('GET', bad.replace(/\/shops\/[^/]+/, `/shops/${A.shopId}`)); check('GET', e.route, bad, 'strange path ids', r2);
    }
    // 6. repeats: one create sent several times with one Idempotency-Key, one after another and all at once; count what was made
    const listBefore = await call('GET', `/api/shops/${A.shopId}/products?limit=200`);
    const countOf = (x) => (Array.isArray(x.json) ? x.json : x.json?.items ?? []).length;
    const key = 'fuzz-' + Math.floor(rnd() * 1e12);
    const mk = () => call('POST', `/api/shops/${A.shopId}/products`, { body: productBody('Fuzz dup ' + key), headers: { 'idempotency-key': key } });
    const seq = [await mk(), await mk()];
    const par = await Promise.all([mk(), mk(), mk(), mk(), mk()]);
    for (const r of [...seq, ...par]) check('POST', '/api/shops/:shopId/products', `/api/shops/${A.shopId}/products`, 'repeat with one Idempotency-Key', r);
    const listAfter = await call('GET', `/api/shops/${A.shopId}/products?limit=200`);
    const made = listAfter.json && listBefore.json ? countOf(listAfter) - countOf(listBefore) : null;
    if (made !== null && made > 1) finding('POST /api/shops/:shopId/products', 'seven sends with one Idempotency-Key', 201, `${made} products made from one key (should be 1)`, 'POST', `/api/shops/${A.shopId}/products`, seq[0], ` -H 'idempotency-key: ${key}'`);
    const ids = new Set([...seq, ...par].filter((r) => r.status === 201).map((r) => r.json?.id));
    if (ids.size > 1) finding('POST /api/shops/:shopId/products', 'seven sends with one Idempotency-Key', 201, `${ids.size} different product ids answered for one key`, 'POST', `/api/shops/${A.shopId}/products`, seq[0], ` -H 'idempotency-key: ${key}'`);
    // same title sent at once with no key: only reported as a note when many are made (the API may allow equal titles)
  }
  return { A, B, routes, done };
}

let ctx;
try { ctx = await main(); } catch (e) { console.error('fuzz-seller-api stopped: ' + e.message); process.exitCode = 2; }
const rows = [...findings.values()];
const one = (v, n = 400) => String(v).replace(/[\t\r\n]+/g, ' ').slice(0, n);
fs.writeFileSync(path.join(OUT, 'findings.tsv'), ['endpoint\tmutation\tstatus\twhy it is a finding\tcurl line to replay\tseen'].concat(rows.map((f) => [one(f.endpoint), one(f.mutation), f.status, one(f.why), one(f.curl, 3000), f.count].join('\t'))).join('\n') + '\n');
// the curl text is long and may contain tabs after escaping; keep it unshortened in its own file too
fs.writeFileSync(path.join(OUT, 'replay.sh'), rows.map((f) => `# ${f.endpoint} | ${f.mutation} | ${f.why}\n${f.curl}\n`).join('\n'));
log.end();
const byWhy = {}; for (const f of rows) { const k = f.why.replace(/[:(].*/, '').trim(); byWhy[k] = (byWhy[k] ?? 0) + 1; }
console.log(`\nfuzz-seller-api done: ${stats.requests} requests (${stats.limited} slowed by rate limits), ${ctx?.done.endpoints.size ?? 0}/${ctx?.routes.length ?? 0} endpoints, ${rows.length} distinct findings`);
for (const [k, n] of Object.entries(byWhy).sort((a, b) => b[1] - a[1])) console.log(`  ${n} x ${k}`);
console.log(`findings: ${path.relative(ROOT, OUT)}/findings.tsv  (replay: source ${path.relative(ROOT, OUT)}/login.sh, lines in replay.sh; seed ${SEED})`);
