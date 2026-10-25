import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { resetRateLimits, sellerCall } from '../../helpers';
import { shopPath } from './support';

/**
 * AI QA, track "odd-data" (map: scripts/aiqa/coverage/odd-data.tsv, how to use it: scripts/aiqa/tracks/odd-data/README.md).
 * Runs on the shop that `node scripts/aiqa/tracks/odd-data/seed.mjs` builds: 10,000 products and 5,000 order slices full of odd data
 * (six scripts, emoji, right-to-left text, very long words, zero-width and combining characters, prices at rounding edges, stock at
 * 0 / 1 / 5 / 6 / 1,000,000,000, orders around midnight UTC at month, year, leap-day and DST boundaries, products and orders in
 * JPY / KWD / BHD / USD). The seed writes the manifest `/tmp/fe/odd-data.json` (override with the env variable ODD_DATA_FILE).
 * Without that file every test here skips itself, so the normal suite is not affected.
 *
 * One test per map line; the line id is in the title and in the `aiqa-lines` annotation. Every list is read twice: through the real API
 * (the saved truth) and on the screen; the two must agree. Nothing here changes data except the `edit-price-*` tests (they edit EDGE
 * products of this throwaway shop).
 *
 * A line can have several tests (the API walk and the screen walk of `paging-10000`; the API checks that also back the stock-filter and
 * currency lines): the line passes only when all of them pass.
 *
 * To point the track at NEW functionality: add data to seed.mjs, a line to the map, and a test below (see the README).
 */

type Manifest = {
  sellerEmail: string;
  password: string;
  shopId: string;
  shopName: string;
  products: { created: number; archived: number; active: number };
  oddCurrency: { id: string; currency: string; priceMinor: number; title: string }[];
  orders: { written: number };
  boundaries: string[];
};
const FILE = process.env.ODD_DATA_FILE ?? '/tmp/fe/odd-data.json';
let loaded: Manifest | undefined;
try {
  loaded = JSON.parse(readFileSync(FILE, 'utf8')) as Manifest;
} catch {
  loaded = undefined;
}
const manifest = (loaded ?? {}) as Manifest;

type Product = { id: string; title: string; brand: string; quantity: number; status: string; priceMinor: number; currency: string; version: number };
type Order = { shopOrderId: string; status: string; subtotalMinor: number; currency: string; createdAt: string; items: unknown[] };

const lines = (...ids: string[]) => test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });

let token = '';
async function signIn(page: Page) {
  await resetRateLimits();
  const api = await sellerCall('POST', '/api/auth/login', { email: manifest.sellerEmail, password: manifest.password });
  expect(api.status, `login ${JSON.stringify(api.data)}`).toBe(200);
  token = api.data.accessToken.token;
  const session = await page.request.post('/api/bff/session', { data: { email: manifest.sellerEmail, password: manifest.password } });
  expect(session.status(), await session.text()).toBeLessThan(300);
}

type Walk<T> = { items: T[]; cursors: (string | null)[]; pages: number };
const walks = new Map<string, Walk<unknown>>();
/** Every page of a keyset list, in order; the cursor that opened each page is kept so a test can open the same page on the screen. Cached per worker (the data does not change). */
async function walk<T>(route: string, limit: number): Promise<Walk<T>> {
  const key = `${route}|${limit}`;
  const hit = walks.get(key);
  if (hit) return hit as Walk<T>;
  const items: T[] = [];
  const cursors: (string | null)[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    cursors.push(cursor);
    const sep = route.includes('?') ? '&' : '?';
    const answer = await sellerCall('GET', `${route}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, undefined, token);
    if (answer.status === 429) {
      await resetRateLimits();
      cursors.pop();
      continue;
    }
    expect(answer.status, `${route} page ${pages}: ${JSON.stringify(answer.data).slice(0, 300)}`).toBe(200);
    items.push(...(answer.data.items as T[]));
    pages++;
    cursor = answer.data.nextCursor ?? null;
    if (!cursor) break;
    expect(pages, 'no endless cursor chain').toBeLessThan(2000);
  }
  const result = { items, cursors, pages };
  walks.set(key, result);
  return result;
}

const productsRoute = () => `/api/shops/${manifest.shopId}/products`;
const ordersRoute = () => `/api/shops/${manifest.shopId}/orders`;

/** The price as the screen must show it, built from the whole-number minor units with no floating point at all. */
function expectedMoney(minor: number, currency: string): string {
  const digits = new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const unit = Math.pow(10, digits); // whole-number arithmetic only: every price here is below 2^53 minor units
  const whole = String(Math.floor(minor / unit)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = digits ? `.${String(minor % unit).padStart(digits, '0')}` : '';
  const symbol = ({ EUR: '€', USD: '$', JPY: '¥', KWD: 'KWD ', BHD: 'BHD ' } as Record<string, string>)[currency] ?? `${currency} `;
  return `${symbol}${whole}${fraction}`;
}
/** Non-breaking and narrow spaces become plain spaces, runs of spaces become one. */
const squash = (text: string) => text.replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Every hit of a shop search (the search answers 20 at a time at most). */
const searches = new Map<string, Product[]>();
async function searchAll(q: string): Promise<Product[]> {
  const hit = searches.get(q);
  if (hit) return hit;
  const found: Product[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const answer = await sellerCall('GET', `${productsRoute()}/search?q=${encodeURIComponent(q)}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, undefined, token);
    expect(answer.status, `search ${q}: ${JSON.stringify(answer.data).slice(0, 200)}`).toBe(200);
    found.push(...(answer.data.items as Product[]));
    cursor = answer.data.nextCursor ?? null;
    if (!cursor) break;
  }
  searches.set(q, found);
  return found;
}

const inventoryRows = (page: Page) => page.locator('[role="region"][aria-label="Products"] tbody tr');
const orderRowsOf = (page: Page) => page.locator('[role="region"][aria-label="Orders"] tbody tr');

type ProductRowShown = { title: string; price: string; stock: string; status: string };
async function readInventoryRows(page: Page): Promise<ProductRowShown[]> {
  return page.locator('[role="region"][aria-label="Products"] tbody tr').evaluateAll((rows) =>
    rows.map((row) => ({
      title: row.querySelector('th[scope="row"]')?.textContent ?? '',
      price: row.querySelector('td[data-label="Price"]')?.textContent ?? '',
      stock: row.querySelector('td[data-label="Stock"]')?.textContent ?? '',
      status: row.querySelector('td[data-label="Status"]')?.textContent ?? '',
    })),
  );
}

async function readOrderRows(page: Page) {
  return page.locator('[role="region"][aria-label="Orders"] tbody tr').evaluateAll((rows) =>
    rows.map((row) => ({
      id: row.querySelector('th[scope="row"]')?.textContent ?? '',
      status: row.querySelector('td[data-label="Status"]')?.textContent ?? '',
      items: row.querySelector('td[data-label="Items"]')?.textContent ?? '',
      subtotal: row.querySelector('td[data-label="Subtotal"]')?.textContent ?? '',
      date: row.querySelector('td[data-label="Date"] time')?.textContent ?? '',
      datetime: row.querySelector('td[data-label="Date"] time')?.getAttribute('datetime') ?? '',
      title: row.querySelector('td[data-label="Date"] time')?.getAttribute('title') ?? '',
    })),
  );
}

const statusLabel = (quantity: number, status: string) => (status === 'ARCHIVED' ? 'Archived' : quantity === 0 ? 'Out of stock' : quantity <= 5 ? 'Low stock' : 'In stock');

/** Nothing sticks out sideways: the page does not scroll horizontally and no element of the main area is wider than the viewport. */
async function expectNoSidewaysOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const width = doc.clientWidth;
    const wide: string[] = [];
    for (const el of Array.from(document.querySelectorAll('#main-content *'))) {
      const box = el.getBoundingClientRect();
      if (box.width > 0 && (box.right > width + 1 || box.left < -1)) wide.push(`${el.tagName.toLowerCase()} ${Math.round(box.left)}..${Math.round(box.right)} "${(el.textContent ?? '').slice(0, 40)}"`);
      if (wide.length > 5) break;
    }
    return { scrollWidth: doc.scrollWidth, clientWidth: width, wide };
  });
  expect.soft(overflow.scrollWidth, `${label}: the page scrolls sideways (${overflow.scrollWidth} > ${overflow.clientWidth}); first elements outside the viewport: ${JSON.stringify(overflow.wide)}`).toBeLessThanOrEqual(overflow.clientWidth);
  expect.soft(overflow.wide, `${label}: elements outside the viewport`).toEqual([]);
}

/** The title cell of one product stays inside the viewport (a search also lists look-alike products, whose long words can widen the whole table, so the page-wide check could blame another row). */
async function expectRowInsideViewport(page: Page, title: string) {
  const row = inventoryRows(page).filter({ has: page.locator('th[scope="row"]').filter({ hasText: title.trim().slice(0, 60) }) }).first();
  await expect(row, `the row of "${title.slice(0, 40)}" is listed`).toBeVisible({ timeout: 20_000 });
  const outside = await row.locator('th[scope="row"]').evaluate((el) => {
    const width = document.documentElement.clientWidth;
    return [el, ...Array.from(el.querySelectorAll('*'))].filter((n) => { const b = n.getBoundingClientRect(); return b.width > 0 && (b.right > width + 1 || b.left < -1); }).slice(0, 4).map((n) => `${n.tagName.toLowerCase()} "${(n.textContent ?? '').slice(0, 30)}"`);
  });
  expect.soft(outside, `title cell of "${title.slice(0, 40)}" outside the viewport`).toEqual([]);
}

/** Opens the list page (20 rows) that holds the item at `index` of a 20-per-page walk; returns the row position on that page. */
async function openListPageHolding(page: Page, area: 'inventory' | 'orders', cursors: (string | null)[], index: number): Promise<number> {
  const pageNo = Math.floor(index / 20);
  const cursor = cursors[pageNo];
  await page.goto(`${shopPath(manifest.shopId, area)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
  await expect(area === 'inventory' ? inventoryRows(page).first() : orderRowsOf(page).first()).toBeVisible();
  return index - pageNo * 20;
}

/** The 30 EDGE products (price x stock), read once from the screen through the search "EDGE". */
let edgeShown: ProductRowShown[] | undefined;
async function loadEdgeRows(page: Page): Promise<ProductRowShown[]> {
  if (edgeShown) return edgeShown;
  const rows: ProductRowShown[] = [];
  await page.goto(`${shopPath(manifest.shopId, 'inventory')}?q=EDGE`);
  for (let pageNo = 0; pageNo < 6; pageNo++) {
    await expect(inventoryRows(page).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[role="region"][aria-label="Products"] table[aria-busy="false"]')).toBeVisible();
    const here = await readInventoryRows(page);
    rows.push(...here);
    const next = page.getByRole('link', { name: 'Next page' });
    if ((await next.count()) === 0) break;
    const firstBefore = here[0]?.title;
    await next.click();
    await page.waitForURL(/cursor=/);
    await expect.poll(async () => (await readInventoryRows(page))[0]?.title, { timeout: 15_000 }).not.toBe(firstBefore);
  }
  edgeShown = rows.filter((r) => r.title.trim().startsWith('EDGE p'));
  return edgeShown;
}
const EDGE_PRICES: [string, number, string][] = [
  ['odd-data.inventory.edge-price-0-01', 1, 'EUR'],
  ['odd-data.inventory.edge-price-0-29', 29, 'EUR'],
  ['odd-data.inventory.edge-price-1-15', 115, 'EUR'],
  ['odd-data.inventory.edge-price-19-99', 1999, 'EUR'],
  ['odd-data.inventory.edge-price-999999-99', 99999999, 'EUR'],
  ['odd-data.inventory.edge-price-max-100000000-00', 10_000_000_000, 'EUR'],
];
const EDGE_STOCKS: [string, number][] = [
  ['odd-data.inventory.edge-stock-0-out-of-stock', 0],
  ['odd-data.inventory.edge-stock-1-low', 1],
  ['odd-data.inventory.edge-stock-5-low-boundary', 5],
  ['odd-data.inventory.edge-stock-6-in-stock-boundary', 6],
  ['odd-data.inventory.edge-stock-1e9-huge', 1_000_000_000],
];

test.describe('Odd data: the shop with 10,000 products and 5,000 orders', () => {
  test.skip(!loaded, `${FILE} is missing: run "node scripts/aiqa/tracks/odd-data/seed.mjs" first (or set ODD_DATA_FILE)`);

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  // ------------------------------------------------------------------------------------------------ paging, API side
  test('[odd-data.inventory.paging-10000] API: walking every product page gives every product once, in order, and the counts agree', async () => {
    lines('odd-data.inventory.paging-10000');
    test.setTimeout(600_000);
    const active = await walk<Product>(`${productsRoute()}?status=ACTIVE`, 100);
    const archived = await walk<Product>(`${productsRoute()}?status=ARCHIVED`, 100);
    const ids = new Set([...active.items, ...archived.items].map((p) => p.id));
    expect(ids.size, 'no product twice, none lost').toBe(active.items.length + archived.items.length);
    expect(active.items.length + archived.items.length).toBe(manifest.products.created);
    expect(archived.items.length).toBe(manifest.products.archived);
    expect(active.items.length).toBe(manifest.products.active);
    // page size 20 (the screen's size) gives the same sequence as page size 100
    const small = await walk<Product>(`${productsRoute()}?status=ACTIVE`, 20);
    expect(small.items.map((p) => p.id)).toEqual(active.items.map((p) => p.id));
  });

  test('[odd-data.inventory.stock-filter-in-stock, odd-data.inventory.stock-filter-out-of-stock] API: the in-stock and out-of-stock filters split the active list with nothing lost', async () => {
    lines('odd-data.inventory.stock-filter-in-stock', 'odd-data.inventory.stock-filter-out-of-stock');
    test.setTimeout(600_000);
    const active = await walk<Product>(`${productsRoute()}?status=ACTIVE`, 100);
    const inStock = await walk<Product>(`${productsRoute()}?status=ACTIVE&inStock=true`, 100);
    const out = await walk<Product>(`${productsRoute()}?status=ACTIVE&inStock=false`, 100);
    expect(inStock.items.every((p) => p.quantity > 0)).toBe(true);
    expect(out.items.every((p) => p.quantity === 0)).toBe(true);
    expect(inStock.items.length + out.items.length).toBe(active.items.length);
    expect(out.items.length).toBe(active.items.filter((p) => p.quantity === 0).length);
  });

  test('[odd-data.orders.paging-5000] API: walking every order page gives all 5,000 slices once, newest first, exact ties kept in id order', async () => {
    lines('odd-data.orders.paging-5000');
    test.setTimeout(600_000);
    const all = await walk<Order>(ordersRoute(), 100);
    expect(all.items.length).toBe(manifest.orders.written);
    expect(new Set(all.items.map((o) => o.shopOrderId)).size, 'no order twice').toBe(all.items.length);
    for (let i = 1; i < all.items.length; i++) {
      const a = all.items[i - 1];
      const b = all.items[i];
      const ta = Date.parse(a.createdAt);
      const tb = Date.parse(b.createdAt);
      expect(ta >= tb && (ta > tb || a.shopOrderId > b.shopOrderId), `order ${i - 1} then ${i}: ${a.createdAt} ${a.shopOrderId} / ${b.createdAt} ${b.shopOrderId}`).toBe(true);
    }
    const small = await walk<Order>(ordersRoute(), 20);
    expect(small.items.map((o) => o.shopOrderId)).toEqual(all.items.map((o) => o.shopOrderId));
  });

  test('[odd-data.orders.paging-5000] API: each order status filter returns exactly the slices of that status', async () => {
    lines('odd-data.orders.paging-5000');
    test.setTimeout(600_000);
    const all = await walk<Order>(ordersRoute(), 100);
    for (const status of ['PAID', 'PENDING', 'CANCELLED', 'REFUNDED']) {
      const part = await walk<Order>(`${ordersRoute()}?status=${status}`, 100);
      expect(part.items.every((o) => o.status === status)).toBe(true);
      expect(part.items.length, `count of ${status}`).toBe(all.items.filter((o) => o.status === status).length);
    }
  });

  test('[odd-data.orders.paging-5000] API: every boundary instant (month, year, leap day, DST day, 23:59:59.999Z) comes back to the millisecond', async () => {
    lines('odd-data.orders.paging-5000');
    test.setTimeout(600_000);
    const all = await walk<Order>(ordersRoute(), 100);
    for (const instant of manifest.boundaries) {
      expect(all.items.some((o) => o.createdAt === instant), `an order at ${instant}`).toBe(true);
    }
  });

  // ------------------------------------------------------------------------------------------------ paging, screen side
  test('[odd-data.inventory.paging-10000] screen: following "Next page" through all the product pages shows the same rows as the API, no duplicate, no gap', async ({ page }) => {
    lines('odd-data.inventory.paging-10000');
    test.setTimeout(1_800_000);
    const api = await walk<Product>(`${productsRoute()}?status=ACTIVE`, 20);
    const seen: string[] = [];
    await page.goto(shopPath(manifest.shopId, 'inventory'));
    for (let pageNo = 0; ; pageNo++) {
      const notFound = page.getByRole('heading', { name: "We couldn't find that shop." });
      await expect(inventoryRows(page).first().or(notFound), `page ${pageNo} shows rows`).toBeVisible();
      if (await notFound.isVisible()) {
        const shop = await sellerCall('GET', `/api/shops/${manifest.shopId}`, undefined, token);
        expect(false, `page ${pageNo} (${page.url()}) says "We couldn't find that shop." although the API answers ${shop.status} for the shop`).toBe(true);
      }
      const rows = await readInventoryRows(page);
      // the page waits for the new rows (the old ones stay dimmed while the next load runs): compare to the API page
      const expected = api.items.slice(pageNo * 20, pageNo * 20 + 20).map((p) => p.title);
      if (rows.map((r) => r.title).join('\u0001') !== expected.join('\u0001')) {
        await expect.poll(async () => (await readInventoryRows(page)).map((r) => r.title).join('\u0001'), { timeout: 15_000, message: `page ${pageNo}` }).toBe(expected.join('\u0001'));
      }
      seen.push(...(await readInventoryRows(page)).map((r) => r.title));
      const next = page.getByRole('link', { name: 'Next page' });
      if ((await next.count()) === 0) {
        await expect(page.locator('[role="region"][aria-label="Products"] table[aria-busy="false"]')).toBeVisible();
        if ((await next.count()) === 0) break;
      }
      await next.click();
      await page.waitForURL(/cursor=/, { timeout: 15_000 }).catch(() => undefined);
      await expect(page.locator('[role="region"][aria-label="Products"] table[aria-busy="false"]')).toBeVisible();
      expect(pageNo, 'no endless paging').toBeLessThan(600);
    }
    expect(seen.length).toBe(manifest.products.active);
    expect(seen).toEqual(api.items.map((p) => p.title));
  });

  test('[odd-data.orders.paging-5000] screen: following "Next page" through all the order pages shows the same rows as the API', async ({ page }) => {
    lines('odd-data.orders.paging-5000');
    test.setTimeout(1_800_000);
    const api = await walk<Order>(ordersRoute(), 20);
    const seen: string[] = [];
    await page.goto(shopPath(manifest.shopId, 'orders'));
    for (let pageNo = 0; ; pageNo++) {
      await expect(orderRowsOf(page).first()).toBeVisible();
      const expected = api.items.slice(pageNo * 20, pageNo * 20 + 20).map((o) => o.shopOrderId.slice(-8));
      await expect.poll(async () => (await readOrderRows(page)).map((r) => r.id).join(','), { timeout: 15_000, message: `page ${pageNo}` }).toBe(expected.join(','));
      seen.push(...(await readOrderRows(page)).map((r) => r.id));
      const next = page.getByRole('link', { name: 'Next page' });
      if ((await next.count()) === 0) break;
      await next.click();
      await page.waitForURL(/cursor=/, { timeout: 15_000 }).catch(() => undefined);
      await expect(page.locator('[role="region"][aria-label="Orders"] table[aria-busy="false"]')).toBeVisible();
      expect(pageNo).toBeLessThan(400);
    }
    expect(seen.length).toBe(manifest.orders.written);
    expect(new Set(seen).size).toBe(new Set(api.items.map((o) => o.shopOrderId.slice(-8))).size);
  });

  // ------------------------------------------------------------------------------------------------ names, text, layout
  test('[odd-data.inventory.first-page-odd-names-and-labels] screen: the first inventory page shows odd names as plain text with the exact price, stock and status label', async ({ page }) => {
    lines('odd-data.inventory.first-page-odd-names-and-labels');
    await page.goto(shopPath(manifest.shopId, 'inventory'));
    await expect(inventoryRows(page).first()).toBeVisible();
    const api = await sellerCall('GET', `${productsRoute()}?status=ACTIVE&limit=20`, undefined, token);
    const shown = await readInventoryRows(page);
    expect(shown.map((r) => r.title)).toEqual((api.data.items as Product[]).map((p) => p.title));
    for (const [i, product] of (api.data.items as Product[]).entries()) {
      expect(squash(shown[i].price), `price of ${product.title}`).toBe(expectedMoney(product.priceMinor, product.currency));
      expect(shown[i].stock.trim()).toBe(String(product.quantity));
      expect(shown[i].status, `status label of ${product.title}`).toContain(statusLabel(product.quantity, product.status));
    }
    // text, not markup: no element inside the title cell
    const markup = await page.locator('[role="region"][aria-label="Products"] tbody th[scope="row"] *').count();
    expect(markup, 'titles are text nodes, not elements').toBe(0);
  });

  /** Finds products by the shape of their title in the full list, then opens the page that finds them through the search box. */
  async function findByShape(shape: RegExp, count: number) {
    const all = await walk<Product>(`${productsRoute()}?status=ACTIVE`, 100);
    return all.items.filter((p) => shape.test(p.title)).slice(0, count);
  }
  const searchToken = (p: Product) => p.title.match(/#\d{5}/)?.[0] ?? p.title;

  test('[odd-data.inventory.long-word-no-spaces] screen: a title that is one very long word wraps inside the page (desktop and phone)', async ({ page }) => {
    lines('odd-data.inventory.long-word-no-spaces');
    test.setTimeout(240_000);
    const long = await findByShape(/\S{100,}/, 3);
    expect(long.length, 'the seed holds titles with a 100+ character word').toBeGreaterThan(0);
    for (const product of long) {
      await page.goto(`${shopPath(manifest.shopId, 'inventory')}?q=${encodeURIComponent(searchToken(product))}`);
      await expect(inventoryRows(page).first()).toBeVisible({ timeout: 20_000 });
      await expectNoSidewaysOverflow(page, `search ${searchToken(product)}`);
    }
  });

  test('[odd-data.inventory.rtl-override-names] screen: names with a right-to-left override or Arabic/Hebrew text wrap inside the page', async ({ page }) => {
    lines('odd-data.inventory.rtl-override-names');
    test.setTimeout(240_000);
    const rtl = await findByShape(/[‮֐-ࣿ]/, 3);
    expect(rtl.length).toBeGreaterThan(0);
    for (const product of rtl) {
      await page.goto(`${shopPath(manifest.shopId, 'inventory')}?q=${encodeURIComponent(searchToken(product))}`);
      await expect(inventoryRows(page).first()).toBeVisible({ timeout: 20_000 });
      await expectRowInsideViewport(page, product.title);
    }
  });

  test('[odd-data.inventory.combining-marks-names] screen: names stacked with combining marks stay inside their row', async ({ page }) => {
    lines('odd-data.inventory.combining-marks-names');
    test.setTimeout(240_000);
    const zalgo = await findByShape(/[̀-ͯ]{2,}/, 2);
    expect(zalgo.length).toBeGreaterThan(0);
    for (const product of zalgo) {
      await page.goto(`${shopPath(manifest.shopId, 'inventory')}?q=${encodeURIComponent(searchToken(product))}`);
      await expect(inventoryRows(page).first()).toBeVisible({ timeout: 20_000 });
      await expectRowInsideViewport(page, product.title);
    }
  });

  test('[odd-data.inventory.long-title-edit-dialog] screen: the edit dialog holds the long title in its field without scrolling sideways', async ({ page }) => {
    lines('odd-data.inventory.long-title-edit-dialog');
    test.setTimeout(240_000);
    const [target] = await findByShape(/\S{100,}/, 1);
    await page.goto(`${shopPath(manifest.shopId, 'inventory')}?q=${encodeURIComponent(searchToken(target))}`);
    await expect(inventoryRows(page).first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: `Actions for ${target.title}` }).first().click();
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    const edit = page.getByRole('dialog', { name: 'Edit product' });
    await expect(edit.getByLabel('Title')).toHaveValue(target.title);
    const dialogOverflow = await edit.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(dialogOverflow.scroll, 'the edit dialog does not scroll sideways').toBeLessThanOrEqual(dialogOverflow.client);
  });

  // ------------------------------------------------------------------------------------------------ prices and stock at the edges
  for (const [id, minor, currency] of EDGE_PRICES) {
    test(`[${id}] screen: the EDGE products priced ${minor} minor units show ${expectedMoney(minor, currency)} and the same saved price`, async ({ page }) => {
      lines(id);
      test.setTimeout(240_000);
      const rows = await loadEdgeRows(page);
      const api = (await searchAll('EDGE')).filter((p) => p.title.startsWith('EDGE p'));
      const mine = rows.filter((r) => r.title.trim().startsWith(`EDGE p${minor} `));
      expect(mine.length, `the screen lists the 5 EDGE products of price ${minor}`).toBe(5);
      for (const r of mine) {
        expect(squash(r.price), `${r.title} shown price`).toBe(expectedMoney(minor, currency));
        expect(api.find((p) => p.title === r.title.trim())?.priceMinor, `${r.title} saved price`).toBe(minor);
      }
    });
  }
  for (const [id, quantity] of EDGE_STOCKS) {
    test(`[${id}] screen: the EDGE products with stock ${quantity} show that number and the label "${statusLabel(quantity, 'ACTIVE')}"`, async ({ page }) => {
      lines(id);
      test.setTimeout(240_000);
      const rows = await loadEdgeRows(page);
      const mine = rows.filter((r) => r.title.trim().endsWith(` s${quantity}`));
      expect(mine.length, `the screen lists the 6 EDGE products with stock ${quantity}`).toBe(6);
      for (const r of mine) {
        expect(r.stock.trim(), `${r.title} shown stock`).toBe(String(quantity));
        expect(r.status, `${r.title} label`).toContain(statusLabel(quantity, 'ACTIVE'));
      }
    });
  }

  // ------------------------------------------------------------------------------------------------ filters
  test('[odd-data.inventory.archived-tab] screen: the Archived tab shows what the API lists, all with the Archived label, without sideways scrolling', async ({ page }) => {
    lines('odd-data.inventory.archived-tab');
    const archived = await sellerCall('GET', `${productsRoute()}?status=ARCHIVED&limit=20`, undefined, token);
    await page.goto(`${shopPath(manifest.shopId, 'inventory')}?status=ARCHIVED`);
    await expect(inventoryRows(page).first()).toBeVisible();
    const shown = await readInventoryRows(page);
    expect(shown.map((r) => r.title)).toEqual((archived.data.items as Product[]).map((p) => p.title));
    expect(shown.every((r) => r.status.includes('Archived'))).toBe(true);
    await expectNoSidewaysOverflow(page, 'archived');
  });

  for (const [id, value, predicate] of [
    ['odd-data.inventory.stock-filter-out-of-stock-screen', 'false', (q: number) => q === 0],
    ['odd-data.inventory.stock-filter-in-stock-screen', 'true', (q: number) => q > 0],
  ] as const) {
    test(`[${id}] screen: the stock filter (inStock=${value}) shows what the API lists`, async ({ page }) => {
      lines(id);
      await page.goto(`${shopPath(manifest.shopId, 'inventory')}?inStock=${value}`);
      await expect(inventoryRows(page).first()).toBeVisible();
      const api = await sellerCall('GET', `${productsRoute()}?status=ACTIVE&inStock=${value}&limit=20`, undefined, token);
      const rows = await readInventoryRows(page);
      expect(rows.map((r) => r.title)).toEqual((api.data.items as Product[]).map((p) => p.title));
      expect(rows.every((r) => predicate(Number(r.stock.trim())))).toBe(true);
    });
  }

  // ------------------------------------------------------------------------------------------------ search
  for (const [id, word] of [
    ['odd-data.inventory.search-cyrillic', 'Кофемолка'],
    ['odd-data.inventory.search-arabic', 'قهوة'],
    ['odd-data.inventory.search-chinese', '咖啡机'],
    ['odd-data.inventory.search-japanese', 'コーヒーミル'],
    ['odd-data.inventory.search-emoji', '😀☕'],
    ['odd-data.inventory.search-accent', 'Crème'],
    ['odd-data.inventory.search-german-sharp-s', 'Straße'],
  ] as const) {
    test(`[${id}] screen: searching "${word}" finds the products that hold it and the screen shows the API hits`, async ({ page }) => {
      lines(id);
      test.setTimeout(120_000);
      await page.goto(`${shopPath(manifest.shopId, 'inventory')}?q=${encodeURIComponent(word)}`);
      const api = await sellerCall('GET', `${productsRoute()}/search?q=${encodeURIComponent(word)}&limit=20`, undefined, token);
      expect(api.status, 'the search call answers').toBe(200);
      await expect(page.locator('[role="region"][aria-label="Products"]')).toBeVisible();
      await expect(page.getByRole('heading', { name: /something went wrong|error/i })).toHaveCount(0);
      const apiTitles = (api.data.items as Product[]).map((p) => p.title);
      expect.soft(apiTitles.length, `"${word}" finds products that hold it`).toBeGreaterThan(0);
      if (apiTitles.length === 0) return;
      expect.soft(apiTitles.some((t) => t.normalize('NFC').includes(word.normalize('NFC'))), `a hit contains "${word}"`).toBe(true);
      await expect(inventoryRows(page).first()).toBeVisible({ timeout: 15_000 });
      expect((await readInventoryRows(page)).map((r) => r.title)).toEqual(apiTitles);
      await expectNoSidewaysOverflow(page, `search ${word}`);
    });
  }

  for (const [id, q] of [
    ['odd-data.inventory.search-hostile-wildcards', '%_\\'],
    ['odd-data.inventory.search-hostile-markup', '<img src=x onerror=alert(1)>'],
    ['odd-data.inventory.search-hostile-sql', "'; DROP TABLE \"Product\"; --"],
    ['odd-data.inventory.search-hostile-zero-width-only', '​​​'],
    ['odd-data.inventory.search-hostile-150-characters', 'a'.repeat(150)],
    ['odd-data.inventory.search-hostile-rtl-override', '‮evil'],
  ] as const) {
    test(`[${id}] screen: a search for hostile text gives an empty list with the text shown as text, no error page`, async ({ page }) => {
      lines(id);
      await page.goto(`${shopPath(manifest.shopId, 'inventory')}?q=${encodeURIComponent(q)}`);
      await expect(page.locator('[role="region"][aria-label="Products"]')).toBeVisible();
      await expect(page.getByText(/stack|sequelize|SELECT |syntax error|ECONN/i)).toHaveCount(0);
      await expect(page.locator('#main-content img[src="x"]')).toHaveCount(0);
      await expectNoSidewaysOverflow(page, `hostile search ${id}`);
      // the shop still has its products afterwards
      const count = await sellerCall('GET', `${productsRoute()}?status=ACTIVE&limit=1`, undefined, token);
      expect(count.status).toBe(200);
    });
  }

  // ------------------------------------------------------------------------------------------------ money
  for (const [id, currency] of [
    ['odd-data.inventory.price-currency-jpy', 'JPY'],
    ['odd-data.inventory.price-currency-kwd', 'KWD'],
    ['odd-data.inventory.price-currency-bhd', 'BHD'],
    ['odd-data.inventory.price-currency-usd', 'USD'],
  ] as const) {
    test(`[${id}] screen: a product booked in ${currency} shows its price with the right number of fraction digits`, async ({ page }) => {
      lines(id);
      test.setTimeout(240_000);
      const odd = manifest.oddCurrency.find((c) => c.currency === currency);
      expect(odd, `the manifest holds a ${currency} product`).toBeTruthy();
      const small = await walk<Product>(`${productsRoute()}?status=ACTIVE`, 20);
      const index = small.items.findIndex((p) => p.id === odd!.id);
      expect(index, `the ${currency} product is in the active list`).toBeGreaterThanOrEqual(0);
      expect(small.items[index].currency).toBe(currency);
      const at = await openListPageHolding(page, 'inventory', small.cursors, index);
      const shown = await readInventoryRows(page);
      expect(shown[at].title).toBe(small.items[index].title);
      expect(squash(shown[at].price)).toBe(expectedMoney(small.items[index].priceMinor, currency));
    });
  }

  for (const [id, currency] of [
    ['odd-data.orders.subtotal-currency-eur', 'EUR'],
    ['odd-data.orders.subtotal-currency-usd', 'USD'],
    ['odd-data.orders.subtotal-currency-jpy', 'JPY'],
    ['odd-data.orders.subtotal-currency-kwd', 'KWD'],
    ['odd-data.orders.subtotal-currency-bhd', 'BHD'],
  ] as const) {
    test(`[${id}] screen: the subtotals of a page of orders that holds a ${currency} order show exactly what the API holds`, async ({ page }) => {
      lines(id);
      test.setTimeout(240_000);
      const small = await walk<Order>(ordersRoute(), 20);
      const index = small.items.findIndex((o) => o.currency === currency);
      expect(index, `an order in ${currency}`).toBeGreaterThanOrEqual(0);
      await openListPageHolding(page, 'orders', small.cursors, index);
      const shown = await readOrderRows(page);
      const slice = small.items.slice(Math.floor(index / 20) * 20, Math.floor(index / 20) * 20 + 20);
      for (const [i, order] of slice.entries()) {
        expect(squash(shown[i].subtotal), `${order.shopOrderId} ${order.currency} ${order.subtotalMinor}`).toBe(expectedMoney(order.subtotalMinor, order.currency));
      }
    });
  }

  test('[odd-data.orders.subtotal-currency-jpy, odd-data.orders.subtotal-currency-kwd] unit: formatMoney gives the exact text for 0, 2 and 3 fraction digits and for the rounding-edge prices', async () => {
    lines('odd-data.orders.subtotal-currency-jpy', 'odd-data.orders.subtotal-currency-kwd');
    const { formatMoney } = await import('../../../lib/utils');
    expect(formatMoney(1234, 'JPY')).toBe('¥1,234');
    expect(squash(formatMoney(1234567, 'KWD'))).toBe('KWD 1,234.567');
    expect(squash(formatMoney(1, 'KWD'))).toBe('KWD 0.001');
    expect(squash(formatMoney(29, 'EUR'))).toBe('€0.29');
    expect(squash(formatMoney(115, 'EUR'))).toBe('€1.15');
    expect(squash(formatMoney(1999, 'EUR'))).toBe('€19.99');
    expect(squash(formatMoney(99999999, 'EUR'))).toBe('€999,999.99');
    expect(squash(formatMoney(10_000_000_000, 'EUR'))).toBe('€100,000,000.00');
    expect(squash(formatMoney(1, 'EUR'))).toBe('€0.01');
  });

  for (const [id, price, field, stock] of [
    ['odd-data.inventory.edit-price-0-29', 29, '0.29', 1],
    ['odd-data.inventory.edit-price-1-15', 115, '1.15', 5],
    ['odd-data.inventory.edit-price-999999-99', 99999999, '999999.99', 6],
    ['odd-data.inventory.edit-price-100000000-00', 10_000_000_000, '100000000.00', 1_000_000_000],
  ] as const) {
    test(`[${id}] screen: the edit form of an EDGE product shows ${field} and saving the brand only, or retyping the price, leaves the price untouched`, async ({ page }) => {
      lines(id);
      test.setTimeout(240_000);
      const edge = (await searchAll('EDGE')).filter((p) => p.title.startsWith('EDGE p'));
      const product = edge.find((p) => p.title === `EDGE p${price} s${stock}`);
      expect(product, `EDGE p${price} s${stock} is found by search`).toBeTruthy();
      const title = `EDGE p${price} s${stock}`;
      await page.goto(`${shopPath(manifest.shopId, 'inventory')}?q=${encodeURIComponent(title)}`);
      await expect(inventoryRows(page).filter({ hasText: title }).first()).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: `Actions for ${title}` }).first().click();
      await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Edit product' });
      await expect(dialog.getByLabel(/^Price/)).toHaveValue(field);
      await expect(dialog.getByLabel('Stock')).toHaveValue(String(stock));
      // change only the brand and save: the price must not move by one minor unit
      await dialog.getByLabel('Brand').fill(`Odd ${Date.now().toString(36)}`);
      await dialog.getByRole('button', { name: 'Save changes' }).click();
      await expect(page.getByText('Product updated').first()).toBeVisible({ timeout: 15_000 });
      const after = await sellerCall('GET', `${productsRoute()}/${product!.id}`, undefined, token);
      expect(after.data.priceMinor, `price after a brand-only edit`).toBe(price);
      expect(after.data.quantity).toBe(stock);
      // retype the price and save: still the same minor units (0.29 * 100 and 1.15 * 100 are not whole in floating point)
      await page.getByRole('button', { name: `Actions for ${title}` }).first().click();
      await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
      await dialog.getByLabel(/^Price/).fill(field === '0.29' ? '0.30' : '1.00');
      await dialog.getByLabel(/^Price/).fill(field);
      await dialog.getByLabel('Brand').fill(`Odd2 ${Date.now().toString(36)}`);
      await dialog.getByRole('button', { name: 'Save changes' }).click();
      await expect(page.getByText('Product updated').first()).toBeVisible({ timeout: 15_000 });
      const again = await sellerCall('GET', `${productsRoute()}/${product!.id}`, undefined, token);
      expect(again.data.priceMinor, `price after retyping ${field}`).toBe(price);
    });
  }

  // ------------------------------------------------------------------------------------------------ dates
  for (const [id, timezoneId] of [
    ['odd-data.orders.date-timezone-kiritimati', 'Pacific/Kiritimati'],
    ['odd-data.orders.date-timezone-pago-pago', 'Pacific/Pago_Pago'],
    ['odd-data.orders.date-timezone-kolkata', 'Asia/Kolkata'],
    ['odd-data.orders.date-timezone-st-johns', 'America/St_Johns'],
  ] as const) {
    test.describe(timezoneId, () => {
      test.use({ timezoneId, locale: 'en-US' });
      test(`[${id}] screen: order dates around midnight UTC are the viewer's local date in ${timezoneId}, with the UTC instant in the tooltip`, async ({ page }) => {
        lines(id);
        test.setTimeout(240_000);
        expect(new Intl.DateTimeFormat('en-US', { timeZone: timezoneId, timeZoneName: 'short' }).format(new Date(0)), 'the zone name is valid').toBeTruthy();
        const small = await walk<Order>(ordersRoute(), 20);
        const consoleErrors: string[] = [];
        page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
        for (const instant of manifest.boundaries) {
          const index = small.items.findIndex((o) => o.createdAt === instant);
          expect(index, `an order at ${instant}`).toBeGreaterThanOrEqual(0);
          const at = await openListPageHolding(page, 'orders', small.cursors, index);
          const row = (await readOrderRows(page))[at];
          const local = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezoneId }).format(new Date(instant));
          expect(row.datetime, 'the machine-readable time is the stored instant').toBe(instant);
          expect(row.title, 'the tooltip names the UTC instant').toBe(`${instant.slice(0, 10)} ${instant.slice(11, 16)} UTC`);
          expect(squash(row.date), `the shown date of ${instant} in ${timezoneId}`).toBe(squash(local));
        }
        const hydration = consoleErrors.filter((t) => /hydrat|did not match|mismatch/i.test(t));
        expect(hydration, 'no server/browser text mismatch while the page loads').toEqual([]);
      });
    });
  }

  // ------------------------------------------------------------------------------------------------ layout with odd data (desktop 1280 and phone 390 by project)
  for (const [id, route] of [
    ['odd-data.layout.inventory-first-page', 'inventory'],
    ['odd-data.layout.inventory-archived', 'inventory?status=ARCHIVED'],
    ['odd-data.layout.inventory-out-of-stock', 'inventory?inStock=false'],
    ['odd-data.layout.orders-first-page', 'orders'],
    ['odd-data.layout.orders-refunded', 'orders?status=REFUNDED'],
    ['odd-data.layout.overview', ''],
  ] as const) {
    test(`[${id}] screen: the page does not scroll sideways with odd data`, async ({ page }) => {
      lines(id);
      await page.goto(shopPath(manifest.shopId, route));
      await expect(page.locator('#main-content h1')).toBeVisible();
      if (route) await expect(page.locator('#main-content tbody tr').first()).toBeVisible({ timeout: 20_000 });
      else await page.waitForLoadState('networkidle').catch(() => undefined);
      await expectNoSidewaysOverflow(page, route || 'overview');
    });
  }
});
