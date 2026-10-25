import { expect, test, type Page } from '@playwright/test';
import { register, resetRateLimits, sellerCall, sellerMenu, shopPath, uniqueShopName, waitForForm, openFiltersIfCollapsed } from './helpers';
import { UNKNOWN_ID, archiveByApi, forced, listProducts, myShops, ownerWithShop, readGallery, readProduct, tokenOf, uniqueTitle, watchApi } from './seller/cross-cutting/support';

/**
 * W04 seller dashboard, the hardening checks that no single area owns (one suite, desktop only): what a reload in the middle, the Back button
 * and a forced API call do to the data. Every test checks the screen, the number of requests the page sent, and the saved state read through
 * the API with the member's own token.
 *
 * Left to the area specs (they own their double press, two-tab and role tests): entry.form.double-press-one-request, inventory.add.double-press,
 * inventory.stock.double-press, inventory.archive.double-press, inventory.menu.restore-double-press, media.save.double-press,
 * inventory.rules.version-sent / stock.version-conflict / stock.stale-row / archive.stale (stale edit and stock, archive in another tab),
 * media.save.conflict, media.leave.unsaved-reload / browser-back, entry.frame.foreign-shop-id, inventory.page.bad-shop-id, orders.page.shop-not-found,
 * media.page.foreign-product, inventory.search.only-own-shop, orders.role.foreign-shop-member, the VIEWER tests of inventory/media/orders.
 * New scenarios: AS-111 (a reload or Back in the middle of a write never duplicates or half-saves), AS-112 (forced calls on another seller's shop
 * answer as for an unknown shop and change nothing).
 */

const rowOf = (page: Page, title: string) => page.getByRole('row').filter({ hasText: title });
const productsPath = (shopId: string) => new RegExp(`^/api/shops/${shopId}/products$`);
const productPath = (shopId: string, id: string) => new RegExp(`^/api/shops/${shopId}/products/${id}$`);

async function openRowMenu(page: Page, title: string, item: string) {
  await page.getByRole('button', { name: `Actions for ${title}` }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

function expectNoneOf(needles: string[], haystacks: Record<string, string>) {
  for (const [where, haystack] of Object.entries(haystacks)) {
    for (const needle of needles) expect(haystack.includes(needle), `${where} must not contain "${needle}"`).toBe(false);
  }
}

test.describe('W04 AS-111 a reload or Back in the middle of a write @desktop', () => {
  test('W04 AS-111 open-shop form: typed text is gone after a reload and nothing was sent', async ({ page }) => {
    const member = await register(page);
    await resetRateLimits();
    await page.goto('/dashboard/seller');
    await waitForForm(page);
    const api = watchApi(page);
    await page.getByLabel('Shop name').fill(uniqueShopName());
    await page.reload();
    await waitForForm(page);
    await expect(page.getByLabel('Shop name')).toHaveValue('');
    expect(api.writes()).toEqual([]);
    expect(await myShops(await tokenOf(member))).toEqual([]);
  });

  test('W04 AS-111 add-product dialog: a reload closes it, nothing is created', async ({ page }) => {
    const { shopId, token } = await ownerWithShop(page);
    await page.goto(shopPath(shopId, 'inventory'));
    await page.getByRole('button', { name: 'Add product' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add product' });
    await dialog.getByLabel('Title').fill(uniqueTitle('Reloaded Mug'));
    const api = watchApi(page);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByText('No products yet.')).toBeVisible();
    expect(api.writes()).toEqual([]);
    expect(await listProducts(token, shopId)).toEqual([]);
  });

  test('W04 AS-111 create product: a reload while the request is on its way never leaves two products', async ({ page }) => {
    const { shopId, token } = await ownerWithShop(page);
    const title = uniqueTitle('Racing Mug');
    await page.goto(shopPath(shopId, 'inventory'));
    await page.getByRole('button', { name: 'Add product' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add product' });
    await dialog.getByLabel('Title').fill(title);
    await dialog.getByLabel('Brand').fill('Clay Works');
    await dialog.getByLabel('Category').fill('kitchen');
    await dialog.getByLabel('Price (EUR)').fill('9.90');
    await dialog.getByLabel('Stock').fill('2');
    // hold the create request back for a moment so the reload overtakes it
    await page.route(productsPath(shopId), async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return route.continue().catch(() => undefined); // the page may be gone by now
    });
    await dialog.getByRole('button', { name: 'Create product' }).click();
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();

    // what the API holds (0 or 1) is exactly what the list shows, and it settles on at most one
    await expect(async () => {
      const saved = (await listProducts(token, shopId)).filter((product) => product.title === title);
      expect(saved.length).toBeLessThanOrEqual(1);
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
      await expect(rowOf(page, title)).toHaveCount(saved.length);
    }).toPass({ timeout: 20_000 });
  });

  test('W04 AS-111 stock popover: a reload closes it and the stock is unchanged', async ({ page }) => {
    const title = uniqueTitle('Reload Stock Mug');
    const { shopId, token, productIds } = await ownerWithShop(page, [{ title, quantity: 5 }]);
    const id = productIds[0] as string;
    const before = await readProduct(token, shopId, id);
    await page.goto(shopPath(shopId, 'inventory'));
    await openRowMenu(page, title, 'Adjust stock');
    await page.getByLabel('New stock').fill('99');
    const api = watchApi(page);
    await page.reload();
    await expect(rowOf(page, title)).toBeVisible();
    await expect(page.getByLabel('New stock')).toBeHidden();
    expect(api.count('PATCH', productPath(shopId, id))).toBe(0);
    expect(await readProduct(token, shopId, id)).toMatchObject({ quantity: 5, version: before.version });
  });

  test('W04 AS-111 after opening a shop, Back does not offer the form again and no second shop appears', async ({ page }) => {
    const member = await register(page);
    await resetRateLimits();
    await page.goto('/dashboard/seller');
    await waitForForm(page);
    const api = watchApi(page);
    await page.getByLabel('Shop name').fill(uniqueShopName());
    await page.getByRole('button', { name: 'Open shop' }).click();
    await expect(page).toHaveURL(/\/dashboard\/seller\/[0-9a-f-]{36}$/);
    const overview = page.url();

    await page.goBack();
    // Opening the shop replaced the form's history entry (B-101), so Back goes to the page before the form and leaves the dashboard
    await expect(page).not.toHaveURL(/\/dashboard\/seller/);
    await expect(page.getByRole('button', { name: 'Open shop' })).toBeHidden();
    await expect(page.getByLabel('Shop name')).toBeHidden();
    // and Forward returns to the new shop's overview, never to the form
    await page.goForward();
    await expect(page).toHaveURL(overview);
    await expect(page.getByRole('button', { name: 'Open shop' })).toBeHidden();
    expect(api.count('POST', /^\/api\/shops$/)).toBe(1);
    expect(await myShops(await tokenOf(member))).toHaveLength(1);
  });

  test('W04 AS-111 inventory: Back undoes the Archived tab and Forward brings it back', async ({ page }) => {
    const title = uniqueTitle('Back Tab Mug');
    const { shopId, token, productIds } = await ownerWithShop(page, [{ title }]);
    await archiveByApi(token, shopId, productIds[0] as string);
    await page.goto(shopPath(shopId, 'inventory'));
    await expect(page.getByText('No products yet.')).toBeVisible();

    const filters = await openFiltersIfCollapsed(page);
    await filters.getByRole('tab', { name: 'Archived' }).click();
    await expect(page).toHaveURL(/status=ARCHIVED/);
    if (await page.getByRole('dialog', { name: 'Filters' }).isVisible()) await page.getByRole('button', { name: 'Done' }).click();
    await expect(rowOf(page, title)).toBeVisible();

    await page.goBack();
    await expect(page).not.toHaveURL(/status=ARCHIVED/);
    await expect(page.getByText('No products yet.')).toBeVisible();
    await expect(rowOf(page, title)).toBeHidden();
    await page.goForward();
    await expect(page).toHaveURL(/status=ARCHIVED/);
    await expect(rowOf(page, title)).toBeVisible();
  });

  test('W04 AS-111 inventory: Back after an archive leaves the page without sending anything, Forward shows the archived state', async ({ page }) => {
    const title = uniqueTitle('Back Archive Mug');
    const { shopId, token, productIds } = await ownerWithShop(page, [{ title }]);
    const id = productIds[0] as string;
    const before = await readProduct(token, shopId, id);
    await page.goto(shopPath(shopId));
    await (await sellerMenu(page)).getByRole('navigation', { name: 'Seller' }).getByRole('link', { name: 'Inventory' }).click();
    await expect(page).toHaveURL(new RegExp(`${shopPath(shopId, 'inventory')}$`));
    await openRowMenu(page, title, 'Archive');
    const api = watchApi(page);
    await page.getByRole('dialog', { name: 'Archive product?' }).getByRole('button', { name: 'Archive product' }).click();
    await expect(page.getByText('Product archived')).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${shopPath(shopId)}$`));
    await page.goForward();
    await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
    await expect(rowOf(page, title)).toBeHidden();
    expect(api.count('POST', new RegExp(`${id}/archive$`))).toBe(1);
    expect(api.writes()).toHaveLength(1);
    expect(await readProduct(token, shopId, id)).toMatchObject({ status: 'ARCHIVED', version: before.version + 1 });
  });


  test('W04 AS-111 an open dialog is not a history step: Back leaves the page and nothing is created', async ({ page }) => {
    const { shopId, token } = await ownerWithShop(page);
    await page.goto(shopPath(shopId));
    await page.goto(shopPath(shopId, 'inventory'));
    await page.getByRole('button', { name: 'Add product' }).first().click();
    await page.getByRole('dialog', { name: 'Add product' }).getByLabel('Title').fill(uniqueTitle('Never Saved Mug'));
    const api = watchApi(page);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${shopPath(shopId)}$`));
    await expect(page.getByRole('dialog')).toBeHidden();
    expect(api.writes()).toEqual([]);
    expect(await listProducts(token, shopId)).toEqual([]);
  });
});

test.describe('W04 AS-112 seller A cannot reach the data of seller B @desktop', () => {
  test('W04 AS-112 forced API calls from A\'s session answer for B\'s shop exactly as for an unknown shop, and change nothing', async ({ page, browser }) => {
    const productTitle = uniqueTitle('Hidden Forced Mug');
    const brand = `Secret-Brand-${Date.now().toString(36)}`;
    const other = await browser.newContext();
    try {
      const b = await ownerWithShop(await other.newPage(), []);
      const created = await sellerCall('POST', `/api/shops/${b.shopId}/products`, { title: productTitle, brand, category: 'secret', priceMinor: 1500, quantity: 4, description: 'Only the owner sees this.' }, b.token);
      expect(created.status).toBe(201);
      const productId = created.data.id as string;
      const before = await readProduct(b.token, b.shopId, productId);
      const galleryBefore = await readGallery(b.token, b.shopId, productId);
      const a = await ownerWithShop(page, []);
      const needles = [b.shopName, productTitle, brand, b.member.email, 'Only the owner sees this.'];

      type Call = { method: 'GET' | 'POST' | 'PATCH' | 'PUT'; route: (shop: string, product: string) => string; body?: unknown };
      const calls: Call[] = [
        { method: 'GET', route: (s) => `/api/shops/${s}` },
        { method: 'GET', route: (s) => `/api/shops/${s}/products` },
        { method: 'GET', route: (s, p) => `/api/shops/${s}/products/${p}` },
        { method: 'GET', route: (s) => `/api/shops/${s}/products/search?q=${encodeURIComponent(productTitle)}` },
        { method: 'GET', route: (s) => `/api/shops/${s}/orders` },
        { method: 'GET', route: (s, p) => `/api/shops/${s}/products/${p}/gallery` },
        { method: 'POST', route: (s) => `/api/shops/${s}/products`, body: { title: 'Planted', brand: 'Planted', category: 'planted', priceMinor: 100, currency: 'EUR', quantity: 1 } },
        { method: 'PATCH', route: (s, p) => `/api/shops/${s}/products/${p}`, body: { expectedVersion: before.version, quantity: 999, title: 'Taken over' } },
        { method: 'POST', route: (s, p) => `/api/shops/${s}/products/${p}/archive`, body: { expectedVersion: before.version } },
        { method: 'PUT', route: (s, p) => `/api/shops/${s}/products/${p}/gallery`, body: { mediaIds: [], expectedVersion: galleryBefore.version } },
        { method: 'POST', route: (s) => `/api/shops/${s}/media/uploads`, body: { purpose: 'product' } },
      ];
      for (const call of calls) {
        const theirs = await forced(page, call.method, call.route(b.shopId, productId), call.body);
        const unknown = await forced(page, call.method, call.route(UNKNOWN_ID, UNKNOWN_ID), call.body);
        const label = `${call.method} ${call.route('{shop}', '{product}')}`;
        expect(theirs.status, label).toBeGreaterThanOrEqual(400);
        expect(theirs.status, label).toBe(unknown.status);
        expect(theirs.json?.code, label).toBe(unknown.json?.code);
        expectNoneOf(needles, { [label]: theirs.text });
      }

      // A's own shop with B's product id is an unknown product too
      for (const call of calls.filter((entry) => entry.route('x', 'y').includes('/products/y'))) {
        const theirs = await forced(page, call.method, call.route(a.shopId, productId), call.body);
        const unknown = await forced(page, call.method, call.route(a.shopId, UNKNOWN_ID), call.body);
        const label = `own shop: ${call.method} ${call.route('{shop}', '{product}')}`;
        expect(theirs.status, label).toBeGreaterThanOrEqual(400);
        expect(theirs.status, label).toBe(unknown.status);
        expectNoneOf(needles, { [label]: theirs.text });
      }

      // nothing of B changed (read with B's own token)
      expect(await readProduct(b.token, b.shopId, productId)).toEqual(before);
      expect(await listProducts(b.token, b.shopId)).toHaveLength(1);
      expect(await readGallery(b.token, b.shopId, productId)).toEqual(galleryBefore);
      expect(await listProducts(a.token, a.shopId)).toEqual([]);
    } finally {
      await other.close();
    }
  });
});
