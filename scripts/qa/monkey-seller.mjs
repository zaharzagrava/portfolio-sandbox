#!/usr/bin/env node
// A "monkey" for the seller dashboard: a brand-new seller clicks, types, uploads, goes back, reloads and resizes at random, and every
// bug-looking thing is written down. No AI involved; the same --seed repeats the same choices.
//   node scripts/qa/monkey-seller.mjs [--minutes 5] [--seed N] [--viewport phone|desktop] [--web http://localhost:3000] [--api http://localhost:8000] [--headed]
// Result: specs/.checkpoints/qa-monkey/<timestamp>/{findings.tsv, actions.jsonl, shots/}. Notes in plain words: docs/work/speedup-notes/qa-monkey-fuzz.md
// Needs the stack running (WITH_WEB=1 scripts/qa/stack-up.sh). One browser, one page. Never logs out and never deletes the account:
// those words are skipped and those requests are blocked.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (args.includes('-h') || args.includes('--help')) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 8).join('\n')); process.exit(0); }
const MINUTES = Number(opt('minutes', 5));
const SEED = Number(opt('seed', Date.now() % 1e9));
const VIEWPORT = opt('viewport', 'desktop');
const WEB = opt('web', process.env.WEB_URL ?? 'http://localhost:3000');
const API = opt('api', process.env.API_URL ?? 'http://localhost:8000');
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1366, height: 800 } };
if (!SIZES[VIEWPORT]) { console.error('--viewport must be phone or desktop'); process.exit(2); }
const require = createRequire(path.join(ROOT, 'packages/web/package.json'));
const { chromium } = require('@playwright/test');
let AxeBuilder = null; try { AxeBuilder = require('@axe-core/playwright').default ?? require('@axe-core/playwright').AxeBuilder; } catch { /* axe not installed: skipped */ }

const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.join(ROOT, 'specs/.checkpoints/qa-monkey', STAMP);
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
const DEADLINE = Date.now() + MINUTES * 60_000;
const PASSWORD = 'SuperSecurePassword123!';

let st = SEED >>> 0;
const rnd = () => { st = (st + 0x6d2b79f5) >>> 0; let t = st; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- what the monkey types ----------
const TEXT = ['Blue mug', '', ' ', 'x'.repeat(10_000), '😀🧑‍🚀🏳️‍🌈 日本語 Ünïcödé', 'مرحبا بالعالم ‮reversed‬', '<script>window.__pwned=1</script>', '<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>', "'; DROP TABLE products; --", '{{7*7}} ${7*7} %s %n', '../../etc/passwd', 'null', 'undefined', '\u0000‮﻿', 'a\nb\tc', '9'.repeat(40)];
const NUMS = ['0', '1', '-1', '-999999', '99999999999999999999', '1e308', '0.001', '2147483648', '9007199254740993', '', '5'];
const EMAILS = ['a@b.co', 'not-an-email', '', 'x'.repeat(300) + '@example.com', 'ünï@例え.jp', '<b>@x.com'];
const URLS = ['https://example.com', 'javascript:alert(1)', 'http://', 'ftp://x', '//evil', 'https://' + 'a'.repeat(3000) + '.com', ''];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const FILES = [
  { name: 'ok.png', mimeType: 'image/png', buffer: PNG },
  { name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('this is not a picture') },
  { name: 'empty.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(0) },
  { name: 'run.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ' + 'x'.repeat(200)) },
  { name: 'sku,title,price\nA1,Mug,10.5.csv', mimeType: 'text/csv', buffer: Buffer.from('sku,title,price\nA1,Mug,10.5\nA2,"Unclosed,-5\n') },
  { name: 'ok.csv', mimeType: 'text/csv', buffer: Buffer.from('title,brand,category,quantity,priceMinor\nMonkey mug,Test,mugs,3,1500\n') },
  { name: '日本語 😀.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
  { name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(3 * 1024 * 1024, 7) },
];

// ---------- never do these ----------
const FORBIDDEN_TEXT = /log ?out|sign ?out|log ?off|delete (my |your )?account|close (my |your )?account|deactivate|remove account|danger zone|delete user|erase (my )?data|leave (the )?shop|transfer ownership/i;
const BLOCKED_REQUEST = [/\/api\/auth\/logout/, /\/api\/bff\/session(\?|$)/, /\/api\/(users|account|me)\b.*(delete|erase)/i, /\/api\/users\/me(\/|$)/, /\/(logout|signout)(\/|\?|$)/i, /\/api\/auth\/(delete|password|mfa|sessions)/];

// ---------- findings ----------
const findings = new Map();
const actionLog = fs.createWriteStream(path.join(OUT, 'actions.jsonl'));
let step = 0, currentAction = 'setup', shotCount = 0, page, stats = { actions: 0, errors: 0 };
const esc = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').slice(0, 500);
const routeOf = (u) => { try { return new URL(u, WEB).pathname.replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '/:id'); } catch { return u; } };
async function addFinding(kind, url, detail, extraKey = '') {
  let d0 = String(detail); const csp = d0.match(/^(.*?Content Security Policy directive:? ?'[a-z-]+)/s); if (csp) d0 = csp[1];
  const message = d0.replace(/nonce-[\w+\/=-]+/g, 'nonce-X').replace(/\d{3,}/g, 'N').replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, 'ID').slice(0, 160);
  const key = [kind, routeOf(url), message, extraKey].join('|');
  const f = findings.get(key);
  if (f) { f.count++; return; }
  let shot = '';
  try { if (page && shotCount < 150) { shot = `shots/${String(step).padStart(4, '0')}-${kind}.png`; await page.screenshot({ path: path.join(OUT, shot), timeout: 5000 }); shotCount++; } } catch { shot = ''; }
  findings.set(key, { kind, url, action: currentAction, detail: String(detail), seed: SEED, step, shot, count: 1 });
  console.log(`  finding [${kind}] ${routeOf(url)}: ${esc(detail).slice(0, 110)}`);
}
const NOISE = [/Download the React DevTools/i, /favicon/i, /Failed to load resource/i /* the network listener reports statuses */, /\[Fast Refresh\]/i, /\[HMR\]/i, /ResizeObserver loop/i];
const LEAKS = [[/\bat [\w$.<>]+ \([^)]*\.(js|ts):\d+/, 'stack trace'], [/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[^"]{0,80}\b(FROM|VALUES|SET|WHERE)\b/i, 'SQL text'], [/(\/home\/[\w.-]+\/|\/usr\/src\/|\/app\/(src|dist)|node_modules\/)/, 'file path'], [/(QueryFailedError|PrismaClient|TypeError:|ReferenceError:|ECONNREFUSED)/, 'internal error text']];

function wire(p) {
  p.on('pageerror', (e) => addFinding('page-error', p.url(), e.message));
  p.on('console', (m) => { if (m.type() !== 'error') return; const t = m.text(); if (NOISE.some((r) => r.test(t))) return; addFinding('console-error', p.url(), t); });
  p.on('crash', () => addFinding('page-crash', p.url(), 'the page crashed'));
  p.on('dialog', (d) => d.dismiss().catch(() => {}));
  p.on('response', async (res) => {
    try {
      const req = res.request(); const u = res.url(); const status = res.status();
      if (!u.startsWith(WEB) && !u.startsWith(API)) return;
      if (status >= 500) return void addFinding('http-5xx', p.url(), `${req.method()} ${routeOf(u)} -> ${status}`);
      if (status >= 400 && req.method() === 'GET' && req.resourceType() === 'document') return void addFinding('http-4xx-page', p.url(), `GET ${routeOf(u)} -> ${status}`);
      if (status === 404 && req.method() === 'GET' && /\/_next\/static\//.test(u)) return void addFinding('missing-asset', p.url(), `${routeOf(u)} -> 404`);
      if (/\/api\//.test(u) && status >= 400) {
        const text = (await res.text()).slice(0, 4000);
        for (const [re, name] of LEAKS) if (re.test(text)) addFinding('leaked-internals', p.url(), `${req.method()} ${routeOf(u)} -> ${status} shows ${name}: ${(text.match(re) ?? [''])[0].slice(0, 60)}`);
      }
    } catch { /* body gone */ }
  });
  p.on('requestfailed', (req) => { const f = req.failure()?.errorText ?? ''; if (/ERR_ABORTED|NS_BINDING_ABORTED|net::ERR_BLOCKED/.test(f)) return; addFinding('request-failed', p.url(), `${req.method()} ${routeOf(req.url())}: ${f}`); });
}

// ---------- set-up: a fresh seller with a shop ----------
async function setup(context) {
  const email = `monkey-${Date.now().toString(36)}${Math.floor(Math.random() * 1e5).toString(36)}@example.com`;
  const created = await context.request.post(`${WEB}/api/auth/register`, { data: { email, password: PASSWORD } });
  if (created.status() >= 300) throw new Error(`register: ${created.status()} ${await created.text()}`);
  const signedIn = await context.request.post(`${WEB}/api/bff/session`, { data: { email, password: PASSWORD } });
  if (signedIn.status() >= 300) throw new Error(`login: ${signedIn.status()} ${await signedIn.text()}`);
  const direct = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  const token = (await direct.json()).accessToken.token;
  const slug = `monkey-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const shop = await fetch(`${API}/api/shops`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ name: `Monkey ${slug}`, slug }) });
  if (shop.status !== 201) throw new Error(`open shop: ${shop.status} ${await shop.text()}`);
  const shopId = (await shop.json()).id;
  await fetch(`${API}/api/shops/${shopId}/products`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ title: 'Monkey first mug', brand: 'Test', category: 'mugs', quantity: 5, priceMinor: 1999, description: 'Made by the monkey.', tags: ['monkey'] }) });
  return { email, shopId };
}

// every seller page: the folders of the web app (with the real shop id put in) plus the links found while walking
function staticRoutes(shopId) {
  const out = ['/dashboard/seller'];
  const base = path.join(ROOT, 'packages/web/app/dashboard/seller');
  const walk = (d, rel) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (!f.isDirectory()) continue;
      const r = rel + '/' + f.name;
      if (/\[(?!shopId)/.test(f.name)) continue;   // other dynamic parts have no known id here; the crawl finds real ones through links
      if (fs.existsSync(path.join(d, f.name, 'page.tsx'))) out.push(('/dashboard/seller' + r).replace('[shopId]', shopId));
      walk(path.join(d, f.name), r);
    }
  };
  try { walk(base, ''); } catch { /* app folder not where expected */ }
  return out;
}
const routes = new Set();
const inSeller = (u) => { try { const x = new URL(u, WEB); return x.origin === new URL(WEB).origin && x.pathname.startsWith('/dashboard/seller'); } catch { return false; } };
async function harvestLinks() {
  try {
    const hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')));
    for (const h of hrefs) if (h && inSeller(h)) { const p = new URL(h, WEB).pathname; if (routes.size < 200) routes.add(p); }
  } catch { /* page moving */ }
}

// ---------- the actions ----------
async function listTargets() {
  return page.evaluate(() => {
    document.querySelectorAll('[data-monkey]').forEach((e) => e.removeAttribute('data-monkey'));
    const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && !e.disabled && e.getAttribute('aria-hidden') !== 'true'; };
    const sel = 'a[href], button, [role=button], [role=tab], [role=menuitem], [role=switch], [role=checkbox], summary, input, textarea, select, [contenteditable=true]';
    const list = []; let n = 0;
    for (const e of document.querySelectorAll(sel)) {
      if (!vis(e) || n >= 300) continue;
      e.setAttribute('data-monkey', String(n));
      const tag = e.tagName.toLowerCase();
      list.push({ i: n, tag, type: e.getAttribute('type') || '', text: (e.innerText || e.getAttribute('aria-label') || e.getAttribute('title') || e.value || '').trim().slice(0, 80), label: e.getAttribute('aria-label') || e.getAttribute('name') || e.getAttribute('placeholder') || '', href: e.getAttribute('href') || '', role: e.getAttribute('role') || '' });
      n++;
    }
    return list;
  });
}
const isField = (t) => ['input', 'textarea', 'select'].includes(t.tag) || t.role === 'textbox';
const isDanger = (t) => FORBIDDEN_TEXT.test(`${t.text} ${t.label} ${t.href}`) || /logout|signout|\/account|\/settings\/security/i.test(t.href);

async function doAction(kind, targets) {
  const L = (i) => page.locator(`[data-monkey="${i}"]`).first();
  const T = { timeout: 1500 };
  const safeClickables = targets.filter((t) => !isField(t) && !isDanger(t) && (!t.href || inSeller(t.href) || t.href.startsWith('#')));
  const fields = targets.filter((t) => isField(t) && t.type !== 'hidden' && !isDanger(t));
  switch (kind) {
    case 'click': { const t = pick(safeClickables); if (!t) return 'nothing to click'; currentAction = `click ${t.tag} "${t.text || t.label}"${t.href ? ' -> ' + t.href : ''}`; await L(t.i).click({ ...T, force: rnd() < 0.05 }); return currentAction; }
    case 'fill': {
      const t = pick(fields.filter((f) => !['file', 'checkbox', 'radio', 'submit', 'button', 'range', 'color'].includes(f.type))); if (!t) return 'no field';
      if (t.tag === 'select') { const o = await L(t.i).locator('option').count(); const k = Math.floor(rnd() * Math.max(o, 1)); currentAction = `select option ${k} in "${t.label}"`; await L(t.i).selectOption({ index: k }, T); return currentAction; }
      let v = ['number'].includes(t.type) ? pick(NUMS) : t.type === 'email' ? pick(EMAILS) : t.type === 'url' ? pick(URLS) : pick(TEXT);
      if (/price|amount|quantity|stock|qty|count|limit/i.test(t.label + t.text)) v = pick(NUMS);
      currentAction = `fill "${t.label || t.text}" (${t.type || t.tag}) with ${JSON.stringify(v.slice(0, 40))}${v.length > 40 ? ` (${v.length} chars)` : ''}`;
      await L(t.i).fill(v, T); return currentAction;
    }
    case 'check': { const t = pick(fields.filter((f) => ['checkbox', 'radio'].includes(f.type))); if (!t) return 'no checkbox'; currentAction = `toggle "${t.label || t.text}"`; await L(t.i).click(T); return currentAction; }
    case 'upload': {
      const t = pick(fields.filter((f) => f.type === 'file')) ?? targets.find((x) => x.type === 'file'); if (!t) return 'no upload field';
      const files = rnd() < 0.2 ? [pick(FILES), pick(FILES)] : [pick(FILES)];
      currentAction = `upload ${files.map((f) => f.name).join(', ')} to "${t.label}"`; await L(t.i).setInputFiles(files, T); return currentAction;
    }
    case 'submit': {
      currentAction = 'submit the first form (Enter in a field, or its submit button)';
      const t = pick(fields.filter((f) => f.tag === 'input' && !['file', 'checkbox', 'radio'].includes(f.type)));
      if (t && rnd() < 0.5) { await L(t.i).press('Enter', T); return currentAction + ' by Enter'; }
      const b = await page.$('form button[type=submit]:not([disabled]), form button:not([type]):not([disabled])'); if (!b) return 'no form'; const txt = (await b.innerText().catch(() => '')).trim();
      if (FORBIDDEN_TEXT.test(txt)) return 'skipped dangerous submit'; currentAction = `submit form with button "${txt}"`; await b.click(T); return currentAction;
    }
    case 'key': { const k = pick(['Escape', 'Enter', 'Tab', 'Shift+Tab', 'ArrowDown', 'ArrowUp', 'Space', 'PageDown', 'End', 'Control+z']); currentAction = `press ${k}`; await page.keyboard.press(k); return currentAction; }
    case 'back': currentAction = 'go back'; await page.goBack({ timeout: 8000 }).catch(() => {}); return currentAction;
    case 'forward': currentAction = 'go forward'; await page.goForward({ timeout: 8000 }).catch(() => {}); return currentAction;
    case 'reload': currentAction = 'reload'; await page.reload({ timeout: 15000 }); return currentAction;
    case 'resize': { const w = pick([320, 390, 768, 1024, 1366, 1920, 2560]), h = pick([480, 700, 844, 900, 1200]); currentAction = `resize to ${w}x${h}`; await page.setViewportSize({ width: w, height: h }); return currentAction; }
    case 'goto': { const list = [...routes]; const r = pick(list); currentAction = `open ${r}`; await page.goto(WEB + r, { timeout: 20000, waitUntil: 'domcontentloaded' }); return currentAction; }
    case 'scroll': currentAction = 'scroll'; await page.mouse.wheel(0, pick([-3000, 600, 3000])); return currentAction;
    case 'doubleclick': { const t = pick(safeClickables.filter((x) => x.tag === 'button')); if (!t) return 'no button'; currentAction = `double-click "${t.text}"`; await L(t.i).dblclick(T); return currentAction; }
  }
}
const WEIGHTS = [['click', 30], ['fill', 22], ['submit', 8], ['check', 4], ['upload', 5], ['key', 7], ['back', 3], ['forward', 1], ['reload', 3], ['resize', 3], ['goto', 6], ['scroll', 3], ['doubleclick', 3]];
const chooseKind = () => { let x = rnd() * WEIGHTS.reduce((a, [, w]) => a + w, 0); for (const [k, w] of WEIGHTS) { if ((x -= w) < 0) return k; } return 'click'; };

async function checkPage() {
  const url = page.url();
  try {
    const bad = await page.evaluate(() => {
      const t = document.body?.innerText ?? '';
      if (/Application error: a (client|server)-side exception/i.test(t)) return 'Application error page';
      if ([...document.querySelectorAll('nextjs-portal')].some((p) => p.shadowRoot?.querySelector('[data-nextjs-dialog], [data-nextjs-dialog-overlay], [data-nextjs-error-overlay]'))) return 'Next error overlay';
      if (/Internal Server Error|Unhandled Runtime Error/i.test(t)) return 'error text on the page: ' + (t.match(/Internal Server Error|Unhandled Runtime Error/i) ?? [''])[0];
      if (/\b(undefined|NaN|\[object Object\])\b/.test(t.replace(/\s+/g, ' ')) ) return 'raw "' + (t.match(/\b(undefined|NaN|\[object Object\])\b/) ?? [''])[0] + '" shown on the page';
      if (document.documentElement.scrollWidth > window.innerWidth + 40) return 'sideways scroll: page is ' + document.documentElement.scrollWidth + 'px wide in a ' + window.innerWidth + 'px window';
      return '';
    });
    if (bad) await addFinding(/sideways/.test(bad) ? 'layout-overflow' : /raw "/.test(bad) ? 'raw-value-on-page' : 'error-page', url, bad);
    const leak = await page.evaluate(() => document.body?.innerText?.slice(0, 20000) ?? '');
    for (const [re, name] of LEAKS) if (re.test(leak)) await addFinding('leaked-internals', url, `page shows ${name}: ${(leak.match(re) ?? [''])[0].slice(0, 60)}`);
    if (await page.evaluate(() => window.__pwned)) await addFinding('script-ran', url, 'typed script text was executed (window.__pwned set)');
  } catch { /* page navigating */ }
}
const axeSeen = new Set();
async function axeCheck() {
  if (!AxeBuilder) return;
  const key = routeOf(page.url()) + '|' + page.viewportSize()?.width;
  if (axeSeen.has(key)) return; axeSeen.add(key);
  try {
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    for (const v of r.violations.filter((x) => ['serious', 'critical'].includes(x.impact))) await addFinding('accessibility', page.url(), `${v.id} (${v.impact}): ${v.help}; ${v.nodes.length} elements, e.g. ${esc(v.nodes[0]?.target)}`);
  } catch { /* page moved on */ }
}

async function main() {
  console.log(`monkey-seller: seed ${SEED}, ${MINUTES} min, ${VIEWPORT}, axe ${AxeBuilder ? 'on' : 'not installed (skipped)'}, output ${path.relative(ROOT, OUT)}`);
  const browser = await chromium.launch({ headless: !args.includes('--headed') });
  const context = await browser.newContext({ viewport: SIZES[VIEWPORT], baseURL: WEB, acceptDownloads: false });
  await context.route('**/*', (route) => { const u = route.request().url(); return BLOCKED_REQUEST.some((r) => r.test(u)) ? route.abort('blockedbyclient') : route.continue(); });
  let mainPage = null;
  context.on('page', (np) => { if (mainPage && np !== mainPage) { wire(np); setTimeout(() => np.close().catch(() => {}), 1500); } });   // popups and new tabs are looked at, then closed
  const { email, shopId } = await setup(context);
  console.log(`seller ${email}, shop ${shopId}`);
  page = await context.newPage(); mainPage = page; wire(page);
  for (const r of staticRoutes(shopId)) routes.add(r);
  // crawl: open each known route once, collect the links on it (also the sidebar, on a phone after opening the menu button)
  const crawled = new Set();
  for (let guard = 0; guard < 120 && Date.now() < DEADLINE; guard++) {
    const next = [...routes].find((r) => !crawled.has(r)); if (!next) break; crawled.add(next);
    currentAction = `crawl ${next}`; step = 0;
    try { const resp = await page.goto(WEB + next, { timeout: 20000, waitUntil: 'domcontentloaded' }); await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
      if (resp && resp.status() >= 400 && !/\/dashboard\/seller\/\[/.test(next)) await addFinding('http-4xx-page', page.url(), `crawl GET ${next} -> ${resp.status()}`);
      await harvestLinks();
      if (VIEWPORT === 'phone') { const menu = page.getByRole('button', { name: /menu|navigation/i }).first(); if (await menu.isVisible().catch(() => false)) { await menu.click({ timeout: 1500 }).catch(() => {}); await harvestLinks(); } }
      await checkPage(); await axeCheck();
    } catch (e) { await addFinding('page-load-failed', WEB + next, e.message.split('\n')[0]); }
  }
  console.log(`crawl: ${crawled.size} pages opened, ${routes.size} seller routes known`);
  // the random part
  let targets = []; let sinceList = 0;
  while (Date.now() < DEADLINE) {
    step++; stats.actions++;
    let kind = chooseKind(), result = '';
    try {
      if (!inSeller(page.url())) { currentAction = 'back into the seller area'; await page.goto(WEB + pick([...routes]), { timeout: 20000, waitUntil: 'domcontentloaded' }); sinceList = 99; }
      if (sinceList++ > 0 || !targets.length) { targets = await listTargets(); sinceList = 0; }
      result = await doAction(kind, targets);
    } catch (e) { result = 'did not work: ' + e.message.split('\n')[0].slice(0, 120); stats.errors++; }
    sinceList = 99;   // the page may have changed: list again next time
    await sleep(120);
    actionLog.write(JSON.stringify({ step, seed: SEED, kind, url: page.url(), action: currentAction, result }) + '\n');
    await harvestLinks(); await checkPage();
    if (step % 12 === 0) await axeCheck();
  }
  await browser.close();
}

let failed = false;
try { await main(); } catch (e) { failed = true; console.error('monkey-seller stopped: ' + e.stack); process.exitCode = 2; }
actionLog.end();
const rows = [...findings.values()];
fs.writeFileSync(path.join(OUT, 'findings.tsv'), ['kind\turl\taction\tdetail\tseed\tstep\tscreenshot\tseen'].concat(rows.map((f) => [f.kind, f.url, f.action, f.detail, f.seed, f.step, f.shot, f.count].map(esc).join('\t'))).join('\n') + '\n');
const byKind = {}; for (const f of rows) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
console.log(`\nmonkey-seller done${failed ? ' (stopped early)' : ''}: ${stats.actions} actions (${stats.errors} could not be done), ${rows.length} distinct findings`);
for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`  ${n} x ${k}`);
console.log(`findings: ${path.relative(ROOT, OUT)}/findings.tsv  (replay: --seed ${SEED} --viewport ${VIEWPORT}; the action log is actions.jsonl)`);
