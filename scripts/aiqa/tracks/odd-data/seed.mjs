#!/usr/bin/env node
// Track 13 odd-data: builds ONE new shop (own seller, never the demo shop) with 10,000 products and 5,000 order slices full of odd data.
//   node scripts/aiqa/tracks/odd-data/seed.mjs            (the dev stack must be up; API on :8000)
// Products go through the real API (so outbox, search index and projections run as in production); the rate limiter counters are
// cleared between batches (the same thing packages/web/tests/helpers.ts does). The shop gets the Pro plan by SQL like dev-seed.ts.
// Orders have no seller-side API (they come from buyers' checkouts), so the 5,000 slices are written by SQL into BisOrder/BisOrderItem/ShopOrder.
// Result: /tmp/fe/odd-data.json (shop id, login, counts) which packages/web/tests/track/odd-data.spec.ts reads.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(here, '../../../../packages/backend');
const req = createRequire(path.join(backend, 'package.json'));
const { Client } = req('pg');
const Redis = req('ioredis');

const API = process.env.API_URL ?? 'http://localhost:8000';
const OUT = process.env.ODD_DATA_FILE ?? '/tmp/fe/odd-data.json';
const PRODUCTS = Number(process.env.ODD_PRODUCTS ?? 10_000);
const ORDERS = Number(process.env.ODD_ORDERS ?? 5_000);
const PASSWORD = 'SuperSecurePassword123!';
const env = Object.fromEntries(readFileSync(path.join(backend, '.env'), 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));
const stamp = Date.now().toString(36);

async function call(method, route, body, token) {
  const res = await fetch(`${API}${route}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

const redis = new Redis(env.REDIS_URL ?? 'redis://localhost:6300/0', { lazyConnect: true, maxRetriesPerRequest: 1 });
await redis.connect();
async function resetLimits() {
  let cursor = '0';
  do { const [next, keys] = await redis.scan(cursor, 'MATCH', 'rl:*', 'COUNT', 1000); cursor = next; if (keys.length) await redis.del(...keys); } while (cursor !== '0');
}

const db = new Client({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USERNAME, password: env.DB_PASSWORD, database: env.DB_NAME });
await db.connect();

// ---------------------------------------------------------------- people and shop
await resetLimits();
const sellerEmail = `odd-seller-${stamp}@example.com`;
let r = await call('POST', '/api/auth/register', { email: sellerEmail, password: PASSWORD });
if (r.status >= 300) throw new Error(`register seller ${r.status} ${JSON.stringify(r.data)}`);
r = await call('POST', '/api/auth/login', { email: sellerEmail, password: PASSWORD });
let token = r.data.accessToken.token;
const shopName = `Odd Data Shop ${stamp}`;
r = await call('POST', '/api/shops', { name: shopName, slug: `odd-data-${stamp}` }, token);
if (r.status !== 201) throw new Error(`create shop ${r.status} ${JSON.stringify(r.data)}`);
const shopId = r.data.id;
r = await call('POST', '/api/auth/login', { email: sellerEmail, password: PASSWORD });
token = r.data.accessToken.token;
await db.query(
  `INSERT INTO "Subscription" ("id", "subjectType", "subjectId", "priceId", "status", "quantity", "billingAnchorDay", "currentPeriodStart", "currentPeriodEnd", "version")
   SELECT gen_random_uuid(), 'SHOP', $1, pr.id, 'ACTIVE', 1, 1, now() - interval '1 day', now() + interval '30 days', 0
     FROM "Price" pr JOIN "Plan" pl ON pl.id = pr."planId" WHERE pl.code = 'pro' AND pr.interval = 'MONTH' LIMIT 1`, [shopId]);
console.log(`seller ${sellerEmail} shop ${shopId} (Pro plan)`);

const buyers = [];
for (let i = 0; i < 5; i++) {
  const email = `odd-buyer-${stamp}-${i}@example.com`;
  const reg = await call('POST', '/api/auth/register', { email, password: PASSWORD });
  if (reg.status >= 300) throw new Error(`register buyer ${reg.status}`);
  buyers.push((await db.query(`SELECT id FROM "User" WHERE email = $1`, [email])).rows[0].id);
}

// ---------------------------------------------------------------- the odd products
const rnd = (() => { let s = 12345; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; })();
const pick = (a) => a[Math.floor(rnd() * a.length)];
const NAMES = [
  (n) => `Чайник керамічний «Київ» ${n}`, (n) => `Кофемолка электрическая ${n}`, (n) => `قهوة عربية فاخرة ${n}`, (n) => `كوب خزفي مصنوع يدويا ${n}`,
  (n) => `手工陶瓷茶杯 ${n}`, (n) => `高级咖啡机 ${n}`, (n) => `ハンドメイド 陶器のマグカップ ${n}`, (n) => `コーヒーミル ${n}`,
  (n) => `Mug 😀☕ ${n}`, (n) => `🧸🧸 Teddy 👨‍👩‍👧‍👦 ${n}`, (n) => `שעון יד מהודר ${n}`, (n) => `Cafe​​Latte‍ ${n}`,
  (n) => `ééé Crème brûlée ${n}`, (n) => `Z̵̡a̷l̸g̴o̶ ${n}`, (n) => `‮RTL override ${n}‬`,
  (n) => `Ordinary Wooden Spoon ${n}`, (n) => `Straße Ärger Œuvre Ǆ ${n}`, (n) => `İstanbul ı̇ ${n}`, (n) => `A${'b'.repeat(120)} ${n}`,
  (n) => `Pneumonoultramicroscopicsilicovolcanoconiosis${'x'.repeat(60)}${n}`,
];
const BRANDS = ['Test', 'Бренд', 'ماركة', '品牌', 'ブランド', '😀Brand', 'Müller & Söhne', "O'Brien \"Quoted\" <b>", 'Zero​Width'];
const CATS = ['kitchen', 'кухня', 'مطبخ', '厨房', 'キッチン', 'toys', 'tools'];
const EDGE_PRICES = [29, 115, 1999, 99999999, 1, 10_000_000_000, 100, 1005, 9999, 10, 99, 100000, 1234567];
const EDGE_STOCK = [0, 1, 5, 6, 1_000_000_000, 2, 100, 7];

const specs = [];
// fixed edge fixtures first: every price x every stock edge ("EDGE p<minor> s<stock>")
for (const p of [29, 115, 1999, 99999999, 1, 10_000_000_000]) for (const s of [0, 1, 5, 6, 1_000_000_000]) specs.push({ title: `EDGE p${p} s${s}`, priceMinor: p, quantity: s, edge: true });
for (let i = specs.length; i < PRODUCTS; i++) {
  const n = String(i).padStart(5, '0');
  specs.push({ title: pick(NAMES)(`#${n}`), priceMinor: pick(EDGE_PRICES), quantity: pick(EDGE_STOCK) });
}
specs.forEach((s, i) => { s.brand = pick(BRANDS); s.category = pick(CATS); s.description = i % 7 === 0 ? 'Описание 说明 وصف 😀 ' + 'w'.repeat(300) : 'Odd data product.'; });

console.log(`creating ${specs.length} products through the API ...`);
const created = [];
let failures = [];
const queue = specs.map((s, i) => ({ s, i }));
let done = 0;
async function worker() {
  while (queue.length) {
    const { s, i } = queue.shift();
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await call('POST', `/api/shops/${shopId}/products`, { title: s.title, brand: s.brand, category: s.category, priceMinor: s.priceMinor, quantity: s.quantity, description: s.description }, token);
      if (res.status === 201) { created[i] = { ...s, id: res.data.id }; break; }
      if (res.status === 429) { await resetLimits(); continue; }
      if (res.status === 401) { const l = await call('POST', '/api/auth/login', { email: sellerEmail, password: PASSWORD }); token = l.data.accessToken.token; continue; }
      failures.push({ title: s.title, status: res.status, body: JSON.stringify(res.data).slice(0, 300) });
      break;
    }
    if (++done % 500 === 0) { await resetLimits(); console.log(`  ${done}/${specs.length}`); }
  }
}
await resetLimits();
await Promise.all(Array.from({ length: 6 }, worker));
const ok = created.filter(Boolean);
console.log(`products created: ${ok.length}, failed: ${failures.length}`);
if (failures.length) console.log(failures.slice(0, 5));

// archive some through the API (version from the read), keep 150 archived
const toArchive = ok.filter((p) => !p.edge).slice(0, 150);
let archived = 0;
for (const p of toArchive) {
  const cur = await call('GET', `/api/shops/${shopId}/products/${p.id}`, undefined, token);
  const a = await call('POST', `/api/shops/${shopId}/products/${p.id}/archive`, { expectedVersion: cur.data.version }, token);
  if (a.status === 200) { p.archived = true; archived++; } else if (a.status === 429) await resetLimits();
}
await resetLimits();
console.log(`archived: ${archived}`);

// a few products in currencies with 0 and 3 fraction digits (the platform books one currency, so the rows are changed by SQL; the list formats per row)
const oddCurrency = [];
for (const [cur, tag] of [['JPY', 'JPY'], ['KWD', 'KWD'], ['BHD', 'BHD'], ['USD', 'USD']]) {
  const p = ok.filter((x) => !x.edge && !x.archived)[oddCurrency.length + 10];
  await db.query(`UPDATE "Product" SET currency = $1, title = $2 WHERE id = $3`, [cur, `CUR ${tag} Кофе 咖啡 ☕ ${tag}`, p.id]);
  oddCurrency.push({ id: p.id, currency: cur, priceMinor: p.priceMinor, title: `CUR ${tag} Кофе 咖啡 ☕ ${tag}` });
}

// ---------------------------------------------------------------- orders by SQL
// Instants around midnight UTC at month, year, leap-day and DST boundaries, with exact ties, then a spread over two years.
const BOUNDARIES = ['2024-02-29T00:00:00.000Z', '2024-12-31T23:59:59.999Z', '2025-01-01T00:00:00.000Z', '2025-03-30T01:00:00.000Z', '2025-03-31T23:59:59.999Z', '2025-04-01T00:00:00.000Z',
  '2025-10-26T01:00:00.000Z', '2025-11-30T23:59:59.999Z', '2025-12-31T23:59:59.999Z', '2026-01-01T00:00:00.000Z', '2026-02-28T23:59:59.999Z', '2026-03-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z', '2026-07-01T00:00:00.000Z',
  '2026-10-24T23:59:59.999Z', '2026-10-25T00:00:00.000Z'];
const CURRENCIES = [['EUR', 70], ['USD', 10], ['JPY', 6], ['KWD', 5], ['BHD', 3], ['EUR', 6]];
const STATUSES = [['PAID', 'PAID'], ['PENDING', 'PENDING'], ['CANCELLED', 'CANCELLED'], ['REFUNDED', 'REFUNDED'], ['PAID', 'FULFILLING'], ['PAID', 'SHIPPED'], ['PAID', 'DELIVERED']];
const sellable = ok.filter((p) => !p.archived && !p.edge);
const instants = [];
for (let i = 0; i < ORDERS; i++) {
  if (i < 480) { const b = new Date(BOUNDARIES[i % BOUNDARIES.length]); instants.push(new Date(b.getTime() + [-1000, -1, 0, 0, 1, 999][i % 6])); }
  else instants.push(new Date(Date.UTC(2024, 5, 1) + Math.floor(rnd() * 880 * 86_400_000)));
}
const orderRows = []; // [bisId, buyer, createdAt, status, total, currency]
console.log(`writing ${ORDERS} order slices ...`);
await db.query('BEGIN');
for (let i = 0; i < ORDERS; i++) {
  const [bisStatus, shopStatusSource] = STATUSES[i % STATUSES.length];
  const shopStatus = ['PAID', 'PENDING', 'CANCELLED', 'REFUNDED'].includes(shopStatusSource) ? shopStatusSource : 'PAID';
  const cur = (() => { const x = rnd() * 100; let acc = 0; for (const [c, w] of CURRENCIES) { acc += w; if (x < acc) return c; } return 'EUR'; })();
  const lines = 1 + Math.floor(rnd() * 3);
  const items = Array.from({ length: lines }, () => { const p = pick(sellable); const qty = 1 + Math.floor(rnd() * 4); const unit = Math.min(p.priceMinor, 5_000_000); return { p, qty, unit, total: unit * qty }; });
  const subtotal = items.reduce((t, x) => t + x.total, 0);
  const bisId = randomUUID(); const at = instants[i];
  await db.query(`INSERT INTO "BisOrder" (id, "userId", "createdAt", "updatedAt", status, total, currency) VALUES ($1,$2,$3,$3,$4,$5,$6)`, [bisId, buyers[i % buyers.length], at, bisStatus, subtotal, cur]);
  await db.query(`INSERT INTO "ShopOrder" (id, "bisOrderId", "shopId", subtotal, status, "createdAt", "updatedAt") VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$5)`, [bisId, shopId, subtotal, shopStatus, at]);
  for (const x of items) await db.query(`INSERT INTO "BisOrderItem" (id, "bisOrderId", "productId", quantity, "priceAtPurchase", "createdAt", "updatedAt", "shopId", title, "discountMinor", "lineTotalMinor") VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$5,$6,$7,0,$8)`, [bisId, x.p.id, x.qty, x.unit, at, shopId, x.p.title, x.total]);
  orderRows.push({ bisId, at: at.toISOString(), status: shopStatus, subtotal, currency: cur });
}
await db.query('COMMIT');

const manifest = {
  stamp, apiUrl: API, sellerEmail, password: PASSWORD, shopId, shopName,
  products: { requested: PRODUCTS, created: ok.length, archived, failures: failures.length, active: ok.length - archived },
  oddCurrency, orders: { written: ORDERS, byCurrency: Object.fromEntries(CURRENCIES.map(([c]) => [c, orderRows.filter((o) => o.currency === c).length])) },
  boundaries: BOUNDARIES, sampleEdge: ok.filter((p) => p.edge).map((p) => ({ title: p.title, priceMinor: p.priceMinor, quantity: p.quantity })),
};
writeFileSync(OUT, JSON.stringify(manifest, null, 1));
console.log(`done: ${OUT}`);
await db.end(); redis.disconnect();
