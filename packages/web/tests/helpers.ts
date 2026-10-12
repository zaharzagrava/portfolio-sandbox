import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const API_URL = process.env.API_URL ?? 'http://localhost:8000';

/** Created by `pnpm --filter api seed:dev` (global setup). */
export const SEED = {
  admin: 'admin@marketplace.local',
  seller: 'seller@marketplace.local',
  password: 'Demo-Seed-Pw-7491!',
  product: 'Espresso Machine Titanium',
};

export const uniqueEmail = (prefix = 'ui') => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

/**
 * The limiters are per client IP or user (register: 10/hour, create shop: a few per hour) and every journey comes from
 * this machine, so one full run (two projects, a registration or two per journey) would exhaust them and fail with 429.
 * Clears the limiter counters (`rl:*`) of the dev stack's Redis; the policies themselves stay as they are.
 */
export async function resetRateLimits() {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6300/0';
  try {
    // ioredis is the backend package's dependency: resolve it from there
    const Redis = createRequire(path.resolve(__dirname, '../../backend/package.json'))('ioredis');
    const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'rl:*', 'COUNT', 1000);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== '0');
    redis.disconnect();
  } catch (error) {
    console.error(`WARNING: could not reset the rate limits (${(error as Error).message}); a 429 may follow.`);
  }
}

/** The password the journeys give the accounts they register (the seeded accounts use `SEED.password`). */
export const NEW_USER_PASSWORD = 'SuperSecurePassword123!';

/**
 * Waits until React has attached its handlers to the page's form: text typed before that is wiped by the first client
 * render, and a click would submit the form natively.
 */
export async function waitForForm(page: Page) {
  await page.waitForFunction(() => {
    const form = document.querySelector('#main-content form');
    return !!form && Object.keys(form).some((key) => key.startsWith('__reactProps'));
  });
}

/** Signs in through the sign-in form; lands on `returnTo` (a validated same-site path). */
export async function login(page: Page, email: string, password: string, returnTo = '/') {
  await page.goto(returnTo === '/' ? '/login' : `/login?returnTo=${encodeURIComponent(returnTo)}`);
  await waitForForm(page);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new URL(returnTo, 'http://localhost:3000').href);
}

/**
 * Registers through the UI (which, by design, does not sign in: the outcome is the same for every address), then signs in
 * with the new credentials; lands on the home page signed in.
 */
export async function register(page: Page, email = uniqueEmail()) {
  await resetRateLimits();
  const password = NEW_USER_PASSWORD;
  await page.goto('/register');
  await waitForForm(page);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(password);
  await page.getByRole('checkbox', { name: /I agree to the Terms/ }).click();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL('http://localhost:3000/login?notice=registered');
  await login(page, email, password);
  return { email, password };
}

const viewportWidth = (page: Page) => page.viewportSize()?.width ?? 1280;

/** Signs out from the account menu (desktop) or the phone menu's account group; waits for the sign-in page. */
export async function signOut(page: Page) {
  if (viewportWidth(page) >= 1024) {
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Log out' }).click();
  } else {
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible();
    await page.getByRole('button', { name: 'Log out' }).click();
  }
  await expect(page).toHaveURL(/\/login\?notice=signed_out$/);
}

/** Phone layout: the header controls (account, assistant) live in the menu. Opens it; a no-op at desktop width. */
export async function openMenuIfCollapsed(page: Page) {
  if (viewportWidth(page) >= 1024) return; // the menu button is hidden from the lg breakpoint up
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible();
}

/** Closes the phone menu and waits until its slide-out has finished (a re-open during it flickers). */
export async function closeMenu(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Menu' })).toBeHidden();
}

/**
 * Phone layout: the search filters sit in a sheet behind a "Filters" button. Opens it and returns the part of the page
 * holding the filter controls (the sheet on the phone, the whole page at desktop width, where the sidebar is shown).
 */
export async function openFiltersIfCollapsed(page: Page) {
  if (viewportWidth(page) >= 1024) return page.locator('body'); // the sidebar is shown from the lg breakpoint up (W02 FR-181)
  await page.getByRole('button', { name: 'Filters' }).click();
  const sheet = page.getByRole('dialog', { name: 'Filters' });
  await expect(sheet).toBeVisible();
  return sheet;
}

/** Viewports of the two Playwright projects, for specs that switch width inside a test. */
export const WIDTHS = { mobile: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } } as const;

export async function gotoAtWidth(page: Page, width: keyof typeof WIDTHS | number, path: string) {
  const size = typeof width === 'number' ? { width, height: 800 } : WIDTHS[width];
  await page.setViewportSize(size);
  return page.goto(path);
}

/** Response headers (lower-case names) of a plain HTTP GET, without a browser. */
export async function headersOf(request: APIRequestContext, path: string, init: { headers?: Record<string, string> } = {}) {
  const res = await request.get(path, { maxRedirects: 0, ...init });
  return { status: res.status(), headers: res.headers() };
}

/**
 * Starts collecting CSP violations (DOM events and console errors) on the page; the returned function asserts there were none.
 * Call before navigating: `const done = await expectNoCspViolations(page); ...journey...; await done();`
 */
export async function expectNoCspViolations(page: Page) {
  const violations: string[] = [];
  type Holder = { __cspViolations?: string[] };
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      const w = window as unknown as Holder;
      (w.__cspViolations ??= []).push(`${e.violatedDirective} ${e.blockedURI} @${e.sourceFile}:${e.lineNumber} ${e.sample.slice(0, 80)}`);
    });
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Content Security Policy|Refused to/i.test(msg.text())) violations.push(msg.text());
  });
  return async () => {
    const fromDom = await page.evaluate(() => (window as unknown as Holder).__cspViolations ?? []);
    expect([...violations, ...fromDom]).toEqual([]);
  };
}

/**
 * Pretends the visitor is at `lat`/`lng` and allows location for the page's origin (W02 pickup journeys). Call before
 * the page asks; the browser context keeps the permission for later navigations.
 */
export async function grantLocation(page: Page, lat: number, lng: number) {
  const context = page.context();
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: lat, longitude: lng });
}

/** A seeded product's id, found through the real search API (indexing is asynchronous, so poll briefly). */
export async function productId(title = SEED.product): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await fetch(`${API_URL}/api/products/search?q=${encodeURIComponent(title)}`);
    if (res.ok) {
      const body = (await res.json()) as { items: { id: string; title: string }[] };
      const hit = body.items.find((item) => item.title === title);
      if (hit) return hit.id;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`"${title}" is not searchable - is the worker/indexer running (dev-monolith)?`);
}

/**
 * W03 pay step: picks the sandbox test card (shown when `NEXT_PUBLIC_PAYMENTS_SANDBOX=true`, which the Playwright dev
 * server sets) and presses Pay. No card number is typed anywhere.
 */
export async function payWithSandboxCard(page: Page) {
  await page.getByRole('radio', { name: /Visa test card/ }).check();
  await page.getByRole('button', { name: /^Pay / }).click();
}

/** The first seeded product that has bought-together recommendations (S34 dataset D), or `null` when none has. */
export async function productWithRecommendations(request: APIRequestContext): Promise<{ id: string; titles: string[] } | null> {
  const list = await request.get(`${API_URL}/api/products/search?limit=50`);
  if (!list.ok()) return null;
  const { items } = (await list.json()) as { items: { id: string }[] };
  for (const { id } of items) {
    const res = await request.get(`${API_URL}/api/products/${id}/recommendations`);
    if (!res.ok()) continue;
    const body = (await res.json()) as { items?: { title: string }[] };
    if (body.items?.length) return { id, titles: body.items.map((item) => item.title) };
  }
  return null;
}

/**
 * Forgets the trending ranking and the BFF's cached copy of it (Redis, dev stack). Events that earlier tests recorded stay in the
 * 60-minute window, and a spec that asserts "no trending rail" must not depend on what ran before it. The command is the same one
 * the build loop's repair agent may use (`scripts/sdd/stack-fix.sh reset-ranking`).
 */
export function resetRanking() {
  execFileSync('bash', [path.resolve(__dirname, '../../../scripts/sdd/stack-fix.sh'), 'reset-ranking'], { stdio: 'inherit' });
}
