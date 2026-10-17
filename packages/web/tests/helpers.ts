import { createHmac } from 'node:crypto';
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

/**
 * The reset link the dev stack "e-mailed" to `email` (`GET /api/dev/mailbox`, W01 B-7); polls until the mail is there.
 * Returns the path and fragment on the site under test (the mail may name another origin).
 */
export async function getResetLink(email: string): Promise<string> {
  let found = '';
  await expect
    .poll(
      async () => {
        const response = await fetch(`${API_URL}/api/dev/mailbox?to=${encodeURIComponent(email)}`);
        if (!response.ok) return '';
        const { messages } = (await response.json()) as { messages: { links: string[] }[] };
        const link = messages.flatMap((message) => message.links).find((candidate) => candidate.includes('/reset-password'));
        found = link ? new URL(link).pathname + new URL(link).hash : '';
        return found;
      },
      { message: `reset link for ${email}`, timeout: 15_000 },
    )
    .not.toBe('');
  return found;
}

/** RFC 6238 code (HMAC-SHA1, 6 digits, 30 s step) for a base32 secret, with no dependency beyond `node:crypto`. */
export function totp(secret: string, at: number = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/[\s=-]/g, '').toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
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
 * A product of its own in a category nobody else uses (created through the real API as the seller; `quantity` is its stock, 5 by default). Nothing can trend, be bought
 * together or be recommended there, so its page has none of the optional rails whatever the other tests did to the shared ranking
 * (the ranking is rebuilt from a store a test cannot clear, and events stay in its 60-minute window).
 */
export async function sellerCall(method: string, route: string, body?: unknown, token?: string) {
  const res = await fetch(`${API_URL}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined };
}

/** The seeded seller's token and shop id (the same real API calls the seed script makes). */
export async function sellerSession(): Promise<{ token: string; shopId: string }> {
  const login = await sellerCall('POST', '/api/auth/login', { email: SEED.seller, password: SEED.password });
  expect(login.status).toBe(200);
  const token: string = login.data.accessToken.token;
  const mine = await sellerCall('GET', '/api/shops/mine', undefined, token);
  return { token, shopId: (mine.data.items ?? mine.data)[0].id };
}

async function createProduct(session: { token: string; shopId: string }, title: string, category: string, quantity = 5) {
  const created = await sellerCall(
    'POST',
    `/api/shops/${session.shopId}/products`,
    { title, brand: 'Test', category, quantity, priceMinor: 1999, description: `${title}. Product created by a test.`, tags: [category] },
    session.token,
  );
  expect(created.status).toBe(201);
}

export async function createIsolatedProduct(options: { quantity?: number } = {}): Promise<{ id: string; title: string }> {
  const session = await sellerSession();
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const title = `Isolated Lantern ${stamp}`;
  await createProduct(session, title, `isolated-${stamp}`, options.quantity);
  return { id: await productId(title), title };
}

/** The position the journeys give the browser (`geolocation` of the test context) and put the pickup seed next to. */
export const FAKE_LOCATION = { latitude: 52.52, longitude: 13.405 };
export const PICKUP_POINT_NAME = 'Journey Locker';

/**
 * W02 B-6 pickup seed, built through the real seller API: an isolated product, a pickup point of the seed shop 400 m from
 * `FAKE_LOCATION` that is open all week, and 7 units in stock there. Waits until the pickup index answers for it; returns
 * `null` when it never does (the journey then `fixme`s itself, see questions.md Q-W02-6).
 */
export async function createPickupSeed(): Promise<{ productId: string; title: string; pointName: string } | null> {
  const product = await createIsolatedProduct();
  const session = await sellerSession();
  const allDay = [{ open: '00:00', close: '23:59' }];
  const point = await sellerCall(
    'POST',
    `/api/shops/${session.shopId}/pickup-points`,
    {
      name: PICKUP_POINT_NAME,
      address: '1 Journey Street, Berlin',
      lat: FAKE_LOCATION.latitude + 0.0036,
      lng: FAKE_LOCATION.longitude,
      openingHours: { timezone: 'UTC', weekly: { mon: allDay, tue: allDay, wed: allDay, thu: allDay, fri: allDay, sat: allDay, sun: allDay } },
    },
    session.token,
  );
  if (point.status !== 201) return null;
  const stock = await sellerCall('PUT', `/api/shops/${session.shopId}/pickup-points/${point.data.id}/stock/${product.id}`, { quantity: 7 }, session.token);
  if (stock.status >= 300) return null;
  // Both read models (the point list and the product search) are projections: wait for both.
  const where = `lat=${FAKE_LOCATION.latitude}&lng=${FAKE_LOCATION.longitude}&radiusKm=5`;
  const indexed = async (route: string, hit: (body: { items?: { name?: string; productId?: string }[] }) => boolean) => {
    const res = await fetch(`${API_URL}${route}`);
    return res.ok && hit((await res.json()) as { items?: { name?: string; productId?: string }[] });
  };
  for (let attempt = 0; attempt < 45; attempt++) {
    const points = await indexed(`/api/pickup-points/near?${where}&productId=${product.id}`, (body) => body.items?.some((item) => item.name === PICKUP_POINT_NAME) === true);
    const search = await indexed(`/api/search/near?${where}&q=${encodeURIComponent(product.title)}`, (body) => body.items?.some((item) => item.productId === product.id) === true);
    if (points && search) return { productId: product.id, title: product.title, pointName: PICKUP_POINT_NAME };
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return null;
}

export const ASK_DOCUMENT_TITLE = 'Lantern manual';
export const ASK_QUESTION = 'Does the lantern battery last 40 hours?';

/**
 * W02 B-6 ask seed, built through the real seller API: one PUBLIC knowledge document for `productId`, processed by the dev
 * stack's scripted embedder. Waits until the document is READY; answers `false` when it never is (no worker, or no knowledge
 * API), and the journey then marks itself `fixme` (questions.md Q-W02-7).
 */
export async function addAskDocument(productId: string): Promise<boolean> {
  const session = await sellerSession();
  const created = await sellerCall(
    'POST',
    `/api/shops/${session.shopId}/knowledge/documents`,
    {
      title: ASK_DOCUMENT_TITLE,
      visibility: 'PUBLIC',
      productId,
      markdown: '# Battery\nThe lantern battery lasts 40 hours on one charge.',
    },
    session.token,
  );
  if (created.status !== 201) return false;
  const documentId: string = created.data.document.id;
  for (let attempt = 0; attempt < 60; attempt++) {
    const read = await sellerCall('GET', `/api/shops/${session.shopId}/knowledge/documents/${documentId}`, undefined, session.token);
    if (read.data?.status === 'READY') return true;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

/**
 * Makes sure the catalogue holds at least `min` searchable products (a fresh stack has 12 seeded ones, and a search page holds 24),
 * by creating the missing ones through the real API in a category of their own, then waits until search reports them.
 */
export async function ensureCatalogueSize(min: number): Promise<void> {
  const total = async () => {
    const res = await fetch(`${API_URL}/api/products/search?limit=1`);
    return res.ok ? ((await res.json()) as { total: { value: number } }).total.value : 0;
  };
  const missing = min - (await total());
  if (missing > 0) {
    const session = await sellerSession();
    const stamp = Date.now().toString(36);
    for (let i = 0; i < missing; i++) await createProduct(session, `Catalogue Filler ${stamp} ${i}`, `filler-${stamp}`);
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await total()) >= min) return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`the catalogue never reached ${min} searchable products`);
}

/**
 * W02 discussions: opens the product's Discussions tab (when it is not open yet), starts a discussion through the form and
 * waits until the new post is listed. Returns the post's article.
 */
export async function startDiscussion(page: Page, productId: string, title: string, details = '') {
  if (!page.url().includes(`/products/${productId}`)) await page.goto(`/products/${productId}?tab=discussions`);
  const panel = page.getByRole('tabpanel', { name: 'Discussions' });
  const form = panel.getByRole('form', { name: 'Start a discussion' });
  if (!(await form.isVisible())) await panel.getByRole('button', { name: 'Start a discussion' }).click();
  await form.getByRole('textbox', { name: 'Title' }).fill(title);
  if (details) await form.getByRole('textbox', { name: 'Details (optional)' }).fill(details);
  await form.getByRole('button', { name: 'Post', exact: true }).click();
  const article = panel.getByRole('article', { name: title });
  await expect(article).toBeVisible();
  return article;
}

/** The number on the notification bell: 0 when it has no badge. Reads the accessible name ("Notifications, {n} unread"). */
export async function bellCount(page: Page): Promise<number> {
  const name = await page.getByRole('button', { name: /^Notifications/ }).first().getAttribute('aria-label');
  const match = /^Notifications, (\d+) unread$/.exec(name ?? '');
  return match ? Number(match[1]) : 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// W04 seller dashboard helpers (contracts/web-modules.md, "Playwright helpers")
// ---------------------------------------------------------------------------------------------------------------------

/** `/dashboard/seller/{shopId}` or one of its sections (`inventory`, `developers/api-keys`, ...). */
export function shopPath(shopId: string, section?: string): string {
  return `/dashboard/seller/${shopId}${section ? `/${section.replace(/^\//, '')}` : ''}`;
}

/**
 * Opens a shop through the UI from a signed-in page (W04 AS-01..AS-03): fills the open-shop form on `/dashboard/seller`
 * and waits for the new shop's overview. The name is unique per call unless one is given. Returns the shop id read from the
 * address. A member who already has a shop is redirected by the server, so call this as a member without one (`register`).
 */
export async function openShop(page: Page, name = `E2E Shop ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`): Promise<{ shopId: string; shopName: string }> {
  await resetRateLimits();
  await page.goto('/dashboard/seller');
  await waitForForm(page);
  await page.getByLabel('Shop name').fill(name);
  await page.getByRole('button', { name: 'Open shop' }).click();
  await expect(page).toHaveURL(/\/dashboard\/seller\/[0-9a-f-]{36}$/);
  const shopId = new URL(page.url()).pathname.split('/').pop() as string;
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  return { shopId, shopName: name };
}

/**
 * Creates a product in `shopId` through the real API as the shop's own member and returns its id (W04 L-005: a journey
 * never shares stock with another). `auth` names the member (a user from `register`, default password `NEW_USER_PASSWORD`);
 * without it the seeded seller is used, which only fits the seeded seller's shop.
 */
export async function seedProduct(
  shopId: string,
  input: { title?: string; brand?: string; category?: string; priceMinor?: number; quantity?: number; description?: string } = {},
  auth?: { email: string; password?: string },
): Promise<string> {
  const login = await sellerCall('POST', '/api/auth/login', auth ? { email: auth.email, password: auth.password ?? NEW_USER_PASSWORD } : { email: SEED.seller, password: SEED.password });
  expect(login.status).toBe(200);
  const token: string = login.data.accessToken.token;
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const created = await sellerCall(
    'POST',
    `/api/shops/${shopId}/products`,
    {
      title: input.title ?? `Seeded Product ${stamp}`,
      brand: input.brand ?? 'Test',
      category: input.category ?? `seeded-${stamp}`,
      priceMinor: input.priceMinor ?? 1999,
      quantity: input.quantity ?? 5,
      description: input.description ?? 'Product created by a test.',
    },
    token,
  );
  expect(created.status).toBe(201);
  return created.data.id as string;
}

/**
 * The invitation link the dev stack "e-mailed" to `email` (`GET /api/dev/mailbox`, the same development hook as
 * `getResetLink`, W04 R-13); polls until the mail is there. Returns the path on the site under test (`/invites/{token}`).
 * If the dev mailbox does not list invitation mails, `seller-team.spec.ts` is blocked (see its header).
 */
export async function readInviteLink(email: string): Promise<string> {
  let found = '';
  await expect
    .poll(
      async () => {
        const response = await fetch(`${API_URL}/api/dev/mailbox?to=${encodeURIComponent(email)}`);
        if (!response.ok) return '';
        const { messages } = (await response.json()) as { messages: { links: string[] }[] };
        const link = messages.flatMap((message) => message.links).find((candidate) => candidate.includes('/invites/'));
        found = link ? new URL(link).pathname : '';
        return found;
      },
      { message: `invitation link for ${email}`, timeout: 15_000 },
    )
    .not.toBe('');
  return found;
}

/**
 * The Next.js dev server's issue badge sits at the top left, over the phone's "Open menu" button, and takes its clicks once the
 * page has logged a dev warning. It is not part of the product (a production build has none): let clicks pass through it.
 */
export async function clickThroughDevOverlay(page: Page) {
  await page.addStyleTag({ content: 'nextjs-portal { pointer-events: none !important; }' });
}

/**
 * Phone layout of a seller page: the Seller navigation and the shop switcher sit in the drawer behind the shop bar's
 * "Open menu" (the site header has a button of the same name, so it is scoped). Opens it and returns the drawer; at desktop
 * width the sidebar is always there and the `aside` is returned.
 */
export async function sellerMenu(page: Page) {
  if (viewportWidth(page) >= 1024) return page.locator('aside');
  await clickThroughDevOverlay(page);
  await expect(page.getByRole('dialog')).toBeHidden(); // a drawer that is still sliding out blocks the button
  await page.getByRole('region', { name: 'Shop bar' }).getByRole('button', { name: 'Open menu' }).click();
  const drawer = page.getByRole('dialog', { name: 'Seller menu' });
  await expect(drawer).toBeVisible();
  return drawer;
}