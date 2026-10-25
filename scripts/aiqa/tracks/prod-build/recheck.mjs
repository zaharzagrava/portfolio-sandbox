#!/usr/bin/env node
// Re-checks the findings that were only seen on the dev server, on the production build, with the dev server as the control:
//   B-003 CSP "Applying inline style violates style-src" console errors   B-005 hydration mismatch console errors
//   B-026 not-found pages answer HTTP 200                                B-031 GET /api/bff/session 401 logged as a console error
//   node recheck.mjs --dev http://localhost:3000 --prod http://localhost:3100 --api http://localhost:8000 --out result.json
// Opens every seller page of a brand-new seller (desktop 1366 and phone 390) on both servers, listens to console errors and to
// the HTTP status of the navigation. Never logs out, never deletes anything.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const DEV = opt('dev', 'http://localhost:3000'), PROD = opt('prod', 'http://localhost:3100'), API = opt('api', 'http://localhost:8000');
const OUT = opt('out', 'recheck.json');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { chromium } = createRequire(path.join(ROOT, 'packages/web/package.json'))('@playwright/test');
const PASSWORD = 'SuperSecurePassword123!';
const SIZES = { desktop: { width: 1366, height: 800 }, phone: { width: 390, height: 844 } };

async function newSeller(web) {
  const email = `recheck-${Date.now().toString(36)}${Math.floor(Math.random() * 1e5).toString(36)}@example.com`;
  const reg = await fetch(`${web}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  if (reg.status >= 300) throw new Error('register ' + reg.status);
  const direct = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  const token = (await direct.json()).accessToken.token;
  const slug = `recheck-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const shop = await fetch(`${API}/api/shops`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ name: `Recheck ${slug}`, slug }) });
  const shopId = (await shop.json()).id;
  await fetch(`${API}/api/shops/${shopId}/products`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ title: 'Recheck mug', brand: 'Test', category: 'mugs', quantity: 5, priceMinor: 1999, description: 'For the recheck.', tags: ['recheck'] }) });
  return { email, shopId };
}
function sellerRoutes(shopId) {
  const out = ['/dashboard/seller'];
  const base = path.join(ROOT, 'packages/web/app/dashboard/seller');
  const walk = (d, rel) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (!f.isDirectory()) continue;
      const r = rel + '/' + f.name;
      if (/\[(?!shopId)/.test(f.name)) continue;
      if (fs.existsSync(path.join(d, f.name, 'page.tsx'))) out.push(('/dashboard/seller' + r).replace('[shopId]', shopId));
      walk(path.join(d, f.name), r);
    }
  };
  walk(base, '');
  return out;
}
const kindOf = (t) => /violates the following Content Security Policy|Applying inline style violates|style-src/i.test(t) ? 'csp-style'
  : /hydrat|did not match|server rendered HTML/i.test(t) ? 'hydration'
  : /401|Unauthorized/i.test(t) ? 'http-401' : 'other';

async function visit(browser, web, label, email, shopId, routes) {
  const rows = [];
  for (const [vp, size] of Object.entries(SIZES)) {
    const ctx = await browser.newContext({ viewport: size, hasTouch: vp === 'phone', isMobile: vp === 'phone' });
    const signed = await ctx.request.post(`${web}/api/bff/session`, { data: { email, password: PASSWORD } });
    if (signed.status() >= 300) throw new Error(`sign-in on ${label}: ${signed.status()}`);
    for (const route of routes) {
      const page = await ctx.newPage();
      const errs = [];
      page.on('console', (m) => { if (m.type() === 'error') errs.push({ kind: kindOf(m.text()), text: m.text().slice(0, 300) }); });
      page.on('pageerror', (e) => errs.push({ kind: kindOf(e.message), text: 'pageerror: ' + e.message.slice(0, 300) }));
      let status = 0;
      try { const r = await page.goto(web + route, { waitUntil: 'load', timeout: 45_000 }); status = r?.status() ?? 0; await page.waitForTimeout(1500); }
      catch (e) { errs.push({ kind: 'other', text: 'goto failed: ' + String(e.message).slice(0, 200) }); }
      rows.push({ server: label, viewport: vp, route: route.replace(shopId, ':shopId'), status, errors: errs });
      await page.close();
    }
    await ctx.close();
  }
  return rows;
}
async function notFound(browser, web, label, shopId) {
  const ctx = await browser.newContext({ viewport: SIZES.desktop });
  const rows = [];
  const probes = ['/dashboard/seller/00000000-0000-4000-8000-000000000000', '/dashboard/seller/not-a-uuid', `/dashboard/seller/${shopId}/no-such-page`, '/no-such-page-at-all', '/products/00000000-0000-4000-8000-000000000000'];
  for (const p of probes) {
    const page = await ctx.newPage();
    let status = 0, text = '';
    try { const r = await page.goto(web + p, { waitUntil: 'load', timeout: 45_000 }); status = r?.status() ?? 0; text = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 90); } catch (e) { text = 'goto failed'; }
    rows.push({ server: label, probe: p.replace(shopId, ':shopId'), status, text });
    await page.close();
  }
  await ctx.close();
  return rows;
}
async function anonymous(browser, web, label) {
  const rows = [];
  for (const p of ['/', '/login', '/search?q=mug']) {
    const ctx = await browser.newContext({ viewport: SIZES.desktop });
    const page = await ctx.newPage();
    const errs = [], bad = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push({ kind: kindOf(m.text()), text: m.text().slice(0, 300) }); });
    page.on('response', (r) => { if (r.status() === 401) bad.push(r.url().replace(web, '')); });
    try { await page.goto(web + p, { waitUntil: 'load', timeout: 45_000 }); await page.waitForTimeout(2500); } catch { /* counted as nothing */ }
    rows.push({ server: label, route: p, errors: errs, responses401: bad });
    await ctx.close();
  }
  return rows;
}

const browser = await chromium.launch();
const result = { when: new Date().toISOString(), dev: DEV, prod: PROD };
try {
  const { email, shopId } = await newSeller(PROD);
  const routes = sellerRoutes(shopId);
  result.routes = routes.length;
  result.pages = [];
  for (const [web, label] of [[DEV, 'dev'], [PROD, 'prod']]) {
    console.log(`${label}: ${routes.length} pages x 2 sizes`);
    result.pages.push(...(await visit(browser, web, label, email, shopId, routes)));
  }
  result.notFound = [...(await notFound(browser, DEV, 'dev', shopId)), ...(await notFound(browser, PROD, 'prod', shopId))];
  result.anonymous = [...(await anonymous(browser, DEV, 'dev')), ...(await anonymous(browser, PROD, 'prod'))];
} finally { await browser.close(); }
fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
console.log('wrote ' + OUT);
