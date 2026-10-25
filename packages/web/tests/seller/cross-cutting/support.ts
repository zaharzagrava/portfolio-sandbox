import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { API_URL, NEW_USER_PASSWORD, SEED, readInviteLink, register, resetRateLimits, sellerCall, sellerSession, shopPath, uniqueEmail } from '../../helpers';
import { openShopByApi } from '../../seller-setup';

/**
 * Shared set-up and reading helpers of the hardening specs of the four seller areas (entry, inventory, media, orders):
 * `seller-concurrency.spec.ts`, `seller-isolation.spec.ts` and `a11y-seller.spec.ts`. Everything here goes through the real
 * API (the same calls the screens make) so a spec can check the saved result without trusting what the screen says.
 */

export type Member = { email: string; password?: string };

/** An id no shop, product or media row can have. */
export const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111';

/** A 1 x 1 PNG: the smallest photo the upload accepts. */
export const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export const uniqueTitle = (prefix: string) => `${prefix} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

// ---------------------------------------------------------------- reading the saved state through the API

const tokens = new Map<string, string>();

/** The member's API token (a fresh sign-in once per member and worker; the saved state is read with it, never through the page). */
export async function tokenOf(member: Member): Promise<string> {
  const cached = tokens.get(member.email);
  if (cached) return cached;
  const login = await sellerCall('POST', '/api/auth/login', { email: member.email, password: member.password ?? NEW_USER_PASSWORD });
  expect(login.status, `login ${member.email}: ${JSON.stringify(login.data)}`).toBe(200);
  const token: string = login.data.accessToken.token;
  tokens.set(member.email, token);
  return token;
}

export type ProductRow = { id: string; title: string; brand: string; quantity: number; status: 'ACTIVE' | 'ARCHIVED'; version: number; priceMinor: number };

export async function readProduct(token: string, shopId: string, productId: string): Promise<ProductRow> {
  const result = await sellerCall('GET', `/api/shops/${shopId}/products/${productId}`, undefined, token);
  expect(result.status, `read product: ${JSON.stringify(result.data)}`).toBe(200);
  return result.data as ProductRow;
}

/** The member list of the shop (all pages up to `limit`, which the API caps at 100). */
export async function listProducts(token: string, shopId: string, status: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE'): Promise<ProductRow[]> {
  const result = await sellerCall('GET', `/api/shops/${shopId}/products?status=${status}&limit=100`, undefined, token);
  expect(result.status, `list products: ${JSON.stringify(result.data)}`).toBe(200);
  return result.data.items as ProductRow[];
}

export async function readGallery(token: string, shopId: string, productId: string): Promise<{ items: { mediaId: string }[]; version: number }> {
  const result = await sellerCall('GET', `/api/shops/${shopId}/products/${productId}/gallery`, undefined, token);
  expect(result.status, `read gallery: ${JSON.stringify(result.data)}`).toBe(200);
  return result.data;
}

export async function myShops(token: string): Promise<{ id: string; name: string; slug: string }[]> {
  const result = await sellerCall('GET', '/api/shops/mine?limit=50', undefined, token);
  expect(result.status, `my shops: ${JSON.stringify(result.data)}`).toBe(200);
  return (result.data.items ?? result.data) as { id: string; name: string; slug: string }[];
}

/** Archives a product through the API (a shortcut for the specs that start from an archived product). */
export async function archiveByApi(token: string, shopId: string, productId: string): Promise<void> {
  const current = await readProduct(token, shopId, productId);
  const archived = await sellerCall('POST', `/api/shops/${shopId}/products/${productId}/archive`, { expectedVersion: current.version }, token);
  expect(archived.status, `archive: ${JSON.stringify(archived.data)}`).toBe(200);
}

// ---------------------------------------------------------------- members and shops

/** A signed-in member with a shop of their own (and, optionally, products); the page is signed in as that member. */
export async function ownerWithShop(page: Page, products: { title: string; quantity?: number; brand?: string; priceMinor?: number }[] = []) {
  const member = await register(page);
  const { shopId, shopName } = await openShopByApi(member);
  const token = await tokenOf(member);
  const productIds: string[] = [];
  for (const product of products) productIds.push(await seedProductFor(member, shopId, product));
  return { member, shopId, shopName, token, productIds };
}

async function seedProductFor(member: Member, shopId: string, product: { title: string; quantity?: number; brand?: string; priceMinor?: number }): Promise<string> {
  const token = await tokenOf(member);
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const created = await sellerCall(
    'POST',
    `/api/shops/${shopId}/products`,
    {
      title: product.title,
      brand: product.brand ?? 'Test',
      category: `seeded-${stamp}`,
      priceMinor: product.priceMinor ?? 1999,
      quantity: product.quantity ?? 5,
      description: 'Product created by a test.',
    },
    token,
  );
  expect(created.status, `create product: ${JSON.stringify(created.data)}`).toBe(201);
  return created.data.id as string;
}

/** A second shop for a member who already has one (the picker and the switcher need two). */
export async function openSecondShop(member: Member, name = `E2E Second ${Date.now().toString(36)}`): Promise<{ shopId: string; shopName: string }> {
  const token = await tokenOf(member);
  const created = await sellerCall('POST', '/api/shops', { name, slug: `e2e-second-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}` }, token);
  expect(created.status, `second shop: ${JSON.stringify(created.data)}`).toBe(201);
  return { shopId: created.data.id as string, shopName: name };
}

/** Another person's shop that owns `slug` (so the open-shop form answers "handle taken"). */
export async function shopWithSlug(slug: string): Promise<void> {
  await resetRateLimits();
  const email = uniqueEmail('slug-owner');
  const registered = await sellerCall('POST', '/api/auth/register', { email, password: NEW_USER_PASSWORD });
  expect(registered.status, `register ${email}: ${JSON.stringify(registered.data)}`).toBeLessThan(300);
  const token = await tokenOf({ email });
  const created = await sellerCall('POST', '/api/shops', { name: `E2E Slug Owner ${Date.now().toString(36)}`, slug }, token);
  expect(created.status, `shop with slug: ${JSON.stringify(created.data)}`).toBe(201);
}

/** The platform admin suspends (or reinstates) a shop through the real API. */
export async function setSuspended(shopId: string, suspended: boolean): Promise<void> {
  const login = await sellerCall('POST', '/api/auth/login', { email: SEED.admin, password: SEED.password });
  expect(login.status).toBe(200);
  const result = await sellerCall('POST', `/api/admin/shops/${shopId}/${suspended ? 'suspend' : 'reinstate'}`, { reason: 'hardening test' }, login.data.accessToken.token);
  expect(result.status).toBe(200);
}

/** The dev outbox lists invitation mails; without it a VIEWER cannot be made (the same block as `seller-team.spec.ts`). */
export async function devMailboxLists(): Promise<boolean> {
  try {
    const response = await fetch(`${API_URL}/api/dev/mailbox?to=${encodeURIComponent(uniqueEmail('probe'))}`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Makes a registered person a member of the shop with `role`: the owner invites through the API, the person opens the mailed
 * link and presses "Accept invitation" (the only way to a non-owner role). Returns the signed-in page and its context; the caller
 * closes the context.
 */
export async function joinShopAs(browser: Browser, owner: Member, shopId: string, role: 'VIEWER' | 'STAFF' | 'ADMIN'): Promise<{ page: Page; context: BrowserContext; member: Required<Member> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const registered = await register(page);
  const invited = await sellerCall('POST', `/api/shops/${shopId}/invites`, { email: registered.email, role }, await tokenOf(owner));
  expect(invited.status, `invite: ${JSON.stringify(invited.data)}`).toBe(201);
  await page.goto(await readInviteLink(registered.email));
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/seller/${shopId}$`));
  return { page, context, member: registered };
}

/**
 * A buyer places an order for a product of the seeded seller's shop, in a context of their own, so that the seeded shop has an
 * order to read. Returns the seeded shop id and its token.
 */
export async function orderInSeededShop(browser: Browser): Promise<{ shopId: string; token: string }> {
  const { createIsolatedProduct } = await import('../../helpers');
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      navigator.sendBeacon = () => false;
    });
    await page.route('**/api/events', (route) => route.fulfill({ status: 202, contentType: 'application/json', body: '{}' }));
    await register(page);
    const { id } = await createIsolatedProduct({ quantity: 200 });
    await page.goto(`/products/${id}`);
    await page.getByRole('button', { name: 'Add to cart' }).click();
    await expect(page.getByText('Added to cart')).toBeVisible();
    await page.goto('/checkout');
    await page.getByRole('button', { name: 'Place order' }).click();
    await expect(page).toHaveURL(/\/checkout\/pay\/[0-9a-f-]{36}$/);
  } finally {
    await context.close();
  }
  return sellerSession();
}

// ---------------------------------------------------------------- watching what the page sends

export type Seen = { method: string; path: string; status: number | null };

/**
 * Records every `/api/` request the page sends (method, path, answer status). The count of requests is part of what the
 * concurrency specs assert: one press of a button is one request, however fast the second press comes.
 */
export function watchApi(page: Page) {
  const seen: Seen[] = [];
  const bySent = new Map<unknown, Seen>();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return;
    const entry: Seen = { method: request.method(), path: url.pathname, status: null };
    seen.push(entry);
    bySent.set(request, entry);
  });
  page.on('response', (response) => {
    const entry = bySent.get(response.request());
    if (entry) entry.status = response.status();
  });
  return {
    seen,
    matching: (method: string, path: RegExp) => seen.filter((entry) => entry.method === method && path.test(entry.path)),
    count: (method: string, path: RegExp) => seen.filter((entry) => entry.method === method && path.test(entry.path)).length,
    /** Everything that is not a read. */
    writes: () => seen.filter((entry) => entry.method !== 'GET' && entry.method !== 'HEAD' && entry.method !== 'OPTIONS'),
    reset: () => {
      seen.length = 0;
    },
  };
}

/** Bodies of every `/api/` answer the page receives (for "no data of another shop in any network answer"). */
export function recordAnswers(page: Page) {
  const bodies: { url: string; status: number; text: string }[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/api/')) return;
    void response
      .text()
      .then((text) => bodies.push({ url: url.pathname + url.search, status: response.status(), text }))
      .catch(() => undefined); // a body that is no longer available (navigation) is not an answer to inspect
  });
  return bodies;
}

// ---------------------------------------------------------------- forced requests from the browser's own session

/** The proof the BFF wants on every write that comes with the session cookie. */
export async function csrfOf(page: Page): Promise<string> {
  const cookie = (await page.context().cookies()).find((entry) => entry.name === '__Host-bff-csrf');
  expect(cookie, 'the page has a CSRF cookie (it is signed in)').toBeTruthy();
  return decodeURIComponent(cookie?.value ?? '');
}

/** A call the page's session could make but no screen makes: sent from the signed-in context, with the CSRF proof. */
export async function forced(page: Page, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', route: string, data?: unknown): Promise<{ status: number; text: string; json: Record<string, unknown> | null }> {
  const headers: Record<string, string> = method === 'GET' ? {} : { 'X-CSRF-Token': await csrfOf(page) };
  const response = await page.request.fetch(route, { method, headers, ...(data === undefined ? {} : { data }) });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: response.status(), text, json };
}

// ---------------------------------------------------------------- small page helpers

/** The visible text of the page content with the per-request reference removed (two answers to compare). */
export async function mainText(page: Page): Promise<string> {
  const text = await page.locator('#main-content').innerText();
  return text.replace(/Reference:\s*\S+/g, 'Reference: -').replace(/Copy reference/g, '').replace(/\s+/g, ' ').trim();
}

export { shopPath };
