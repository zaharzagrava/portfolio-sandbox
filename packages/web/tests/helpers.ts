import { createRequire } from 'node:module';
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

/** Registers through the UI; lands on the home page signed in. */
export async function register(page: Page, email = uniqueEmail()) {
  await resetRateLimits();
  const password = 'SuperSecurePassword123!';
  await page.goto('/register');
  await page.fill('input[name="name"]', 'UI Test User');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.fill('input[name="confirmPassword"]', password);
  await page.locator('button[id="terms"]').click();
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL('http://localhost:3000/');
  return { email, password };
}

export async function login(page: Page, email: string, password: string, returnUrl = '/') {
  await page.goto(`/login?returnUrl=${encodeURIComponent(returnUrl)}`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(new RegExp(`${returnUrl.replace(/[?]/g, '\\?')}$`));
}

const viewportWidth = (page: Page) => page.viewportSize()?.width ?? 1280;

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
  if (viewportWidth(page) >= 768) return page.locator('body'); // the sidebar is shown from the md breakpoint up
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
