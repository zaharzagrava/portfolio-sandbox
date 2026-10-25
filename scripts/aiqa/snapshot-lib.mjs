// Shared by snapshot.mjs and snapshot-diff.mjs: opens the pages of an area from snapshots.config.json and turns each into parts with a hash.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AIQA, COVERAGE, REPO, sha, today } from './lib.mjs';

export const WEB = process.env.AIQA_WEB_URL ?? 'http://localhost:3000';
export const API = process.env.AIQA_API_URL ?? 'http://localhost:8000';
export const SNAP_DIR = join(COVERAGE, 'snapshots');
export const config = () => JSON.parse(readFileSync(join(AIQA, 'snapshots.config.json'), 'utf8'));

const SEED = { email: 'seller@marketplace.local', password: 'Demo-Seed-Pw-7491!' };
const OWN_PASSWORD = 'SuperSecurePassword123!';

// ---------------------------------------------------------------- normalizing
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?';
const RULES = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{uuid}'],
  [/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g, '{date}'],
  [new RegExp(`${MONTH}\\s+\\d{1,2}(?:,?\\s+\\d{4})?(?:,?\\s+\\d{1,2}:\\d{2}(?::\\d{2})?\\s?(?:AM|PM|am|pm)?)?`, 'g'), '{date}'],
  [new RegExp(`\\d{1,2}\\s+${MONTH}(?:\\s+\\d{4})?`, 'g'), '{date}'],
  [/\b\d{1,2}\/\d{1,2}\/\d{2,4}(?:,?\s+\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM|am|pm)?)?/g, '{date}'],
  [/\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM|am|pm)?\b/g, '{time}'],
  [/\b(?:\d+|an?)\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b|\bjust now\b|\bin\s+\d+\s+(?:second|minute|hour|day)s?\b/gi, '{ago}'],
  [/\b\d+ unread\b/g, '{n} unread'],
  [/\bE2E [A-Za-z ]*?\d{4,}\b/g, '{e2e-name}'],
  [/\b[0-9a-f]{12,}\b/gi, '{hex}'],
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{12,}\b/g, '{rnd}'],
];
export function normalize(html) {
  const stash = [];
  // class lists are already cleaned of hashed names in the page; keep them out of the random-string rules
  let s = html.replace(/ class="[^"]*"/g, (m) => { stash.push(m); return ` class=\u0000${stash.length - 1}\u0000`; });
  for (const [re, to] of RULES) s = s.replace(re, to);
  s = s.replace(/ class=\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
  return s.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- page side: cut the DOM into parts (runs inside the browser)
function extractParts() {
  const DROP = /^(id|for|style|nonce|tabindex|autocomplete|aria-labelledby|aria-controls|aria-describedby|aria-owns|aria-activedescendant|data-nextjs.*|data-radix-.*|data-reactid|data-sentry.*|data-slot-id|data-rac.*|data-floating.*|data-aqa.*)$/;
  const CONTROL = 'button,a[href],input:not([type=hidden]),select,textarea,summary,[role=button],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=checkbox],[role=switch],[role=combobox],[role=option],[role=link],[role=radio]';
  const DIALOG = '[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[popover]:popover-open,dialog[open]';
  const LANDMARK = 'header,nav,main,aside,footer,form,table,[role=banner],[role=navigation],[role=main],[role=complementary],[role=contentinfo],[role=region],[role=search],[role=form],[role=table],[role=status],[role=alert],[role=tablist],[role=toolbar],[role=tooltip]';
  const SKIP = 'nextjs-portal,next-route-announcer,script,style,noscript,template,[data-nextjs-dev-overlay],[data-nextjs-toast]';
  const visible = (el) => !el.closest(SKIP) && (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : true) && !el.closest('[inert],[aria-hidden=true]');
  const collapse = (t) => (t ?? '').replace(/\s+/g, ' ').trim().slice(0, 70);
  const hashedClass = (c) => /^_|^css-|^jsx-|^[A-Za-z]{1,4}[_-]?[A-Za-z0-9]*\d[A-Za-z0-9]*$/.test(c) && !/[-:\[\]\/.]/.test(c) && c.length >= 6 && /\d/.test(c) && /[a-z]/i.test(c);
  const roleOf = (el) => {
    const r = el.getAttribute('role'); if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') { const ty = el.type; return ty === 'checkbox' || ty === 'radio' ? ty : ty === 'submit' || ty === 'button' ? 'button' : ty === 'file' ? 'file' : 'textbox'; }
    return t;
  };
  const nameOf = (el) => {
    const l = el.getAttribute('aria-label'); if (l) return collapse(l);
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\s+/).map((i) => document.getElementById(i)?.textContent ?? '').join(' '); if (collapse(t)) return collapse(t); }
    if (el.labels?.length) return collapse([...el.labels].map((x) => x.textContent).join(' '));
    const own = collapse(el.textContent); if (own) return own;
    const img = el.querySelector('img[alt],svg[aria-label],svg title'); if (img) return collapse(img.getAttribute('alt') ?? img.getAttribute('aria-label') ?? img.textContent);
    return collapse(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('href') || '');
  };
  // a cleaned copy of the element: no ids, no style; nested controls/landmarks collapse to a marker when `shallow`
  const clean = (el, shallow) => {
    const clone = el.cloneNode(true);
    const origs = [el, ...el.querySelectorAll('*')], copies = [clone, ...clone.querySelectorAll('*')];
    const marks = [];
    origs.forEach((o, i) => {
      const c = copies[i];
      if (c.matches(SKIP)) { marks.push([c, null]); return; }
      if (c.tagName.toLowerCase() === 'svg') { [...c.childNodes].forEach((n) => n.remove()); }
      for (const a of [...c.attributes]) {
        if (DROP.test(a.name)) c.removeAttribute(a.name);
        else if (a.name === 'class') { const keep = a.value.split(/\s+/).filter((t) => t && !hashedClass(t)); keep.length ? c.setAttribute('class', keep.join(' ')) : c.removeAttribute('class'); }
      }
      if (shallow && i > 0 && (c.matches(CONTROL) || c.matches(DIALOG) || c.matches(LANDMARK))) marks.push([c, `⟦${roleOf(o)}:${nameOf(o)}⟧`]);
    });
    for (const [c, text] of marks) { if (!c.isConnected) continue; text === null ? c.remove() : c.replaceWith(document.createTextNode(text)); }
    return clone.outerHTML;
  };
  const parts = [];
  const body = document.body;
  for (const el of body.querySelectorAll(`${LANDMARK},${DIALOG},h1,h2,h3`)) {
    if (!visible(el)) continue;
    const isDialog = el.matches(DIALOG), isHead = /^H[123]$/.test(el.tagName);
    const heading = el.querySelector('h1,h2,h3,[role=heading]');
    const name = isHead ? collapse(el.textContent) : collapse(el.getAttribute('aria-label') ?? (heading ? heading.textContent : '')) || '';
    parts.push({ kind: isDialog ? 'dialog' : isHead ? 'heading' : 'landmark', role: isHead ? el.tagName.toLowerCase() : roleOf(el), name, html: clean(el, true) });
  }
  for (const el of body.querySelectorAll(CONTROL)) {
    if (!visible(el)) continue;
    parts.push({ kind: 'control', role: roleOf(el), name: nameOf(el), html: clean(el, false) });
  }
  return parts;
}

export function toParts(raw) {
  const seen = new Map(), out = {};
  for (const p of raw) {
    const base = `${p.kind}:${p.role}:${normalize(p.name)}`;
    const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
    const html = normalize(p.html);
    out[n > 1 ? `${base}#${n}` : base] = { kind: p.kind, role: p.role, label: p.name, hash: sha(html), text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) };
  }
  return out;
}

// ---------------------------------------------------------------- browser, roles, steps
export async function launch() {
  const req = createRequire(join(REPO, 'packages', 'web', 'package.json'));
  const { chromium } = req('@playwright/test');
  return chromium.launch();
}

export async function waitForStack(timeoutMs = 600_000) {
  const t0 = Date.now();
  for (;;) {
    try { if ((await fetch(`${API}/health/ready`)).ok && (await fetch(WEB)).status < 500) return; } catch { /* not up yet */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`stack not ready: ${API}/health/ready and ${WEB}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function call(method, route, body, token) {
  const res = await fetch(`${API}${route}`, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined };
}
const tokenOf = async (email, password) => (await call('POST', '/api/auth/login', { email, password })).data?.accessToken?.token;

/** The demo shop (first shop of the seeded seller) and one product of it. */
export async function demoIds() {
  const token = await tokenOf(SEED.email, SEED.password);
  if (!token) throw new Error('seed seller cannot sign in; is the demo seed loaded?');
  const mine = (await call('GET', '/api/shops/mine', undefined, token)).data;
  const shopId = (mine.items ?? mine)[0].id;
  const list = (await call('GET', `/api/shops/${shopId}/products?limit=50`, undefined, token)).data;
  const items = list?.items ?? [];
  const product = items.find((p) => p.title === 'Espresso Machine Titanium') ?? items[0];
  return { shopId, productId: product?.id ?? '00000000-0000-4000-8000-000000000000', token };
}

const MEMBER_ROLES = { viewer: 'VIEWER', staff: 'STAFF', admin: 'ADMIN' }; // snapshot role -> shop role
const emailOf = (role) => `aiqa-${role}@example.com`;
const OWNER_EMAIL = 'aiqa-owner@example.com';
const ROLE_SHOP = 'AIQA Roles Shop';

async function ensureAccount(email) {
  let token = await tokenOf(email, OWN_PASSWORD);
  if (!token) {
    const r = await call('POST', '/api/auth/register', { email, password: OWN_PASSWORD });
    if (r.status >= 300 && r.status !== 409) throw new Error(`cannot create ${email}: ${r.status} ${JSON.stringify(r.data)} (rate limit? try again later)`);
    token = await tokenOf(email, OWN_PASSWORD);
  }
  return token;
}

/** Waits for the invitation mail in the dev mailbox (the API keeps the last 50 mails in memory: read it right after sending). */
async function inviteToken(email) {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${API}/api/dev/mailbox?to=${encodeURIComponent(email)}`);
    if (res.ok) {
      const link = (await res.json()).messages.flatMap((m) => m.links).find((l) => l.includes('/invites/'));
      if (link) return decodeURIComponent(new URL(link).pathname.split('/invites/')[1]);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

/**
 * A throwaway shop of its own ("AIQA Roles Shop", owned by a helper seller, one product) with one member per role (VIEWER, STAFF, ADMIN),
 * so those roles are snapshotted without adding anyone to the demo shop. Made once; later runs find it again. Returns { shopId, productId, ready: {role: bool} }.
 */
async function ensureRoleShop(roles) {
  const ownerToken = await ensureAccount(OWNER_EMAIL);
  const mine = (await call('GET', '/api/shops/mine', undefined, ownerToken)).data;
  let shop = (mine.items ?? mine).find((x) => x.name === ROLE_SHOP);
  if (!shop) {
    const c = await call('POST', '/api/shops', { name: ROLE_SHOP, slug: `aiqa-roles-${Date.now().toString(36)}` }, ownerToken);
    if (c.status !== 201) throw new Error(`cannot open the roles shop: ${c.status} ${JSON.stringify(c.data)}`);
    shop = c.data;
  }
  const products = (await call('GET', `/api/shops/${shop.id}/products?limit=5`, undefined, ownerToken)).data?.items ?? [];
  let product = products[0];
  if (!product) {
    const c = await call('POST', `/api/shops/${shop.id}/products`, { title: 'AIQA Snapshot Mug', brand: 'Aiqa', category: 'aiqa-snapshot', quantity: 7, priceMinor: 1999, description: 'Product of the AI QA snapshot shop.', tags: ['aiqa-snapshot'] }, ownerToken);
    product = c.data;
  }
  const ready = {};
  for (const role of roles) {
    const token = await ensureAccount(emailOf(role));
    const theirs = (await call('GET', '/api/shops/mine', undefined, token)).data;
    if ((theirs.items ?? theirs).some((x) => x.id === shop.id)) { ready[role] = true; continue; }
    let invited = await call('POST', `/api/shops/${shop.id}/invites`, { email: emailOf(role), role: MEMBER_ROLES[role] }, ownerToken);
    if (invited.status === 409) { // an earlier invitation is still pending: send the mail again
      const pending = (await call('GET', `/api/shops/${shop.id}/invites`, undefined, ownerToken)).data?.items?.find((i) => i.email === emailOf(role) && i.status === 'pending');
      if (pending) invited = await call('POST', `/api/shops/${shop.id}/invites/${pending.id}/resend`, {}, ownerToken);
    }
    const invite = invited.status < 300 ? await inviteToken(emailOf(role)) : null;
    const accepted = invite ? await call('POST', '/api/shop-invites/accept', { token: invite }, token) : { status: 0 };
    ready[role] = accepted.status === 200 || accepted.status === 201;
    if (!ready[role]) console.log(`${role}: could not join the roles shop (invite ${invited.status}, mail ${invite ? 'found' : 'missing'}, accept ${accepted.status}); its states are skipped`);
  }
  return { shopId: shop.id, productId: product?.id ?? '00000000-0000-4000-8000-000000000000', ready };
}

export async function prepare(browser, cfg, target) {
  const ids = await demoIds();
  const used = new Set();
  for (const [area, a] of Object.entries(cfg.areas)) if (target === 'all' || target === area) for (const st of Object.values(a.states)) (st.roles ?? ['owner']).forEach((r) => used.add(r));
  const memberRoles = Object.keys(MEMBER_ROLES).filter((r) => used.has(r));
  if (used.has('noshop')) await ensureAccount(emailOf('noshop'));
  const roleShop = memberRoles.length ? await ensureRoleShop(memberRoles) : { ready: {} };
  return { ids, roleShop };
}

async function contextFor(browser, role, width, ready) {
  const ctx = await browser.newContext({ baseURL: WEB, viewport: { width, height: width >= 1000 ? 800 : 844 }, hasTouch: width < 1000, isMobile: width < 1000, reducedMotion: 'reduce', timezoneId: 'UTC', locale: 'en-US' });
  if (role !== 'anon') {
    const [email, password] = role === 'owner' ? [SEED.email, SEED.password] : [emailOf(role), OWN_PASSWORD];
    const r = await ctx.request.post('/api/bff/session', { data: { email, password } });
    if (r.status() >= 300) throw new Error(`sign-in as ${role} failed: ${r.status()}`);
  }
  return ctx;
}

const locatorOf = (page, t) => {
  if (t.selector) return page.locator(t.selector).first();
  if (t.label) return page.getByLabel(t.label, { exact: t.exact ?? false }).first();
  if (t.text) return page.getByText(t.text, { exact: t.exact ?? false }).first();
  return page.getByRole(t.role, { name: t.name, exact: t.exact ?? false }).first();
};

/** Opens one state for one role and width; returns { parts } or { skipped } or { error }. */
export async function capture(browser, state, role, width, ctxVars) {
  const ctx = await contextFor(browser, role, width);
  try {
    const page = await ctx.newPage();
    const url = state.url.replace(/\{(\w+)\}/g, (_, k) => ctxVars[k] ?? k);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    // text typed or buttons pressed before React has attached its handlers are lost
    await page.waitForFunction(() => [...document.querySelectorAll('button,a,input,form')].some((e) => Object.keys(e).some((k) => k.startsWith('__reactProps'))), null, { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(800);
    for (const step of state.steps ?? []) {
      try {
        if (step.click) await locatorOf(page, step.click).click({ timeout: 4000 });
        else if (step.fill) await locatorOf(page, step.fill).fill(step.fill.value, { timeout: 4000 });
        else if (step.press) await page.keyboard.press(step.press);
        else if (step.wait) await page.waitForTimeout(step.wait);
        else if (step.expect) await locatorOf(page, step.expect).waitFor({ state: 'visible', timeout: 6000 });
        await page.waitForTimeout(step.settle ?? 350);
      } catch (e) {
        if (step.optional) continue;
        return { skipped: `step ${JSON.stringify(step).slice(0, 80)} failed: ${String(e.message).split('\n')[0]}` };
      }
    }
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    const finalPath = new URL(page.url()).pathname.replace(/[0-9a-f-]{36}/g, '{uuid}');
    const parts = toParts(await page.evaluate(extractParts));
    return { parts, finalPath };
  } finally { await ctx.close(); }
}

/** All variants (role x width) of one state. */
export async function captureState(browser, name, state, env, cfg, onlyRoles = null) {
  const variants = {}, notes = [];
  for (const role of state.roles ?? ['owner']) {
    if (onlyRoles && !onlyRoles.includes(role)) continue;
    const member = role in MEMBER_ROLES;
    if (member && !env.roleShop.ready[role]) { notes.push(`${role}: skipped (not a member of the roles shop)`); continue; }
    const vars = member ? { ...env.ids, shopId: env.roleShop.shopId, productId: env.roleShop.productId } : env.ids;
    for (const width of state.widths ?? cfg.widths) {
      const key = `${role}@${width}`;
      try {
        const r = await capture(browser, state, role, width, vars);
        if (r.skipped) notes.push(`${key}: skipped, ${r.skipped}`); else variants[key] = r;
      } catch (e) { notes.push(`${key}: error, ${String(e.message).split('\n')[0]}`); }
    }
  }
  return { variants, notes };
}

export const statePath = (area, name) => join(SNAP_DIR, area, `${name}.json`);
export function saveState(area, name, state, variants) {
  mkdirSync(join(SNAP_DIR, area), { recursive: true });
  writeFileSync(statePath(area, name), JSON.stringify({ url: state.url, at: today(), variants }, null, 1) + '\n');
}
export const loadState = (area, name) => (existsSync(statePath(area, name)) ? JSON.parse(readFileSync(statePath(area, name), 'utf8')) : null);
