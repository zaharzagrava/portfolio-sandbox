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
const ROLE_ACCOUNTS = { viewer: 'aiqa-viewer@example.com', noshop: 'aiqa-noshop@example.com' };

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

/** Makes the fixed helper accounts once: a VIEWER of the demo shop, and a member with no shop. Idempotent. */
export async function ensureAccounts(ids) {
  for (const email of Object.values(ROLE_ACCOUNTS)) {
    if (!(await tokenOf(email, OWN_PASSWORD))) {
      const r = await call('POST', '/api/auth/register', { email, password: OWN_PASSWORD });
      if (r.status >= 300 && r.status !== 409) throw new Error(`cannot create ${email}: ${r.status} ${JSON.stringify(r.data)} (rate limit? wait an hour)`);
    }
  }
  const viewerToken = await tokenOf(ROLE_ACCOUNTS.viewer, OWN_PASSWORD);
  const mine = (await call('GET', '/api/shops/mine', undefined, viewerToken)).data;
  if ((mine.items ?? mine).some((s) => s.id === ids.shopId)) return true;
  const invited = await call('POST', `/api/shops/${ids.shopId}/invites`, { email: ROLE_ACCOUNTS.viewer, role: 'VIEWER' }, ids.token);
  if (invited.status === 409) { // a pending invitation from an earlier run: send the mail again
    const pending = (await call('GET', `/api/shops/${ids.shopId}/invites`, undefined, ids.token)).data?.items?.find((i) => i.email === ROLE_ACCOUNTS.viewer && i.status === 'pending');
    if (pending) await call('POST', `/api/shops/${ids.shopId}/invites/${pending.id}/resend`, {}, ids.token);
  } else if (invited.status !== 201) { console.log(`viewer: invite failed (${invited.status}); VIEWER states are skipped`); return false; }
  return 'invited';
}

async function acceptInvite(browser) {
  const ctx = await browser.newContext({ baseURL: WEB });
  try {
    await ctx.request.post('/api/bff/session', { data: { email: ROLE_ACCOUNTS.viewer, password: OWN_PASSWORD } });
    const page = await ctx.newPage();
    let link;
    for (let i = 0; i < 20 && !link; i++) {
      const res = await fetch(`${API}/api/dev/mailbox?to=${encodeURIComponent(ROLE_ACCOUNTS.viewer)}`);
      if (!res.ok) return false;
      link = (await res.json()).messages.flatMap((m) => m.links).filter((l) => l.includes('/invites/')).pop();
      if (!link) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!link) return false;
    await page.goto(new URL(link).pathname);
    await page.getByRole('button', { name: 'Accept invitation' }).click({ timeout: 8000 });
    await page.waitForURL(/\/dashboard\/seller\/[0-9a-f-]{36}/, { timeout: 15000 });
    return true;
  } catch { return false; } finally { await ctx.close(); }
}

export async function prepare(browser) {
  const ids = await demoIds();
  const r = await ensureAccounts(ids);
  let viewer = r !== false;
  if (r === 'invited') {
    viewer = await acceptInvite(browser);
    if (!viewer) { // no mail to read: do not leave a pending invitation on the demo shop
      const list = (await call('GET', `/api/shops/${ids.shopId}/invites`, undefined, ids.token)).data?.items ?? [];
      for (const i of list.filter((x) => x.email === ROLE_ACCOUNTS.viewer && x.status === 'pending')) await call('DELETE', `/api/shops/${ids.shopId}/invites/${i.id}`, undefined, ids.token);
    }
  }
  if (!viewer) console.log('viewer: could not be made a member (dev mailbox?); VIEWER states are skipped');
  return { ids, viewer };
}

async function contextFor(browser, role, width, ready) {
  const ctx = await browser.newContext({ baseURL: WEB, viewport: { width, height: width >= 1000 ? 800 : 844 }, hasTouch: width < 1000, isMobile: width < 1000, reducedMotion: 'reduce', timezoneId: 'UTC', locale: 'en-US' });
  if (role !== 'anon') {
    const [email, password] = role === 'owner' ? [SEED.email, SEED.password] : [ROLE_ACCOUNTS[role], OWN_PASSWORD];
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
    await page.addInitScript(() => { try { Math.random = () => 0.5; } catch { /* ignore */ } });
    const url = state.url.replace(/\{(\w+)\}/g, (_, k) => ctxVars[k] ?? k);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(600);
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
export async function captureState(browser, name, state, env, cfg) {
  const variants = {}, notes = [];
  for (const role of state.roles ?? ['owner']) {
    if (role === 'viewer' && !env.viewer) { notes.push(`${role}: skipped (no viewer member)`); continue; }
    for (const width of state.widths ?? cfg.widths) {
      const key = `${role}@${width}`;
      try {
        const r = await capture(browser, state, role, width, env.ids);
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
