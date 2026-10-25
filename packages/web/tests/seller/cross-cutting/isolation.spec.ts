import { expect, test, type Page } from '@playwright/test';
import { register, sellerCall, shopPath, uniqueEmail } from '../../helpers';
import {
  UNKNOWN_ID,
  devMailboxLists,
  forced,
  joinShopAs,
  listProducts,
  mainText,
  orderInSeededShop,
  ownerWithShop,
  readGallery,
  readProduct,
  recordAnswers,
  uniqueTitle,
  watchApi,
} from './support';

/**
 * Track 4 (seller isolation), browser side, for the four seller areas.
 *  - Seller A opens the addresses of seller B's shop, product photos and orders: the page is the same "not found" page as for an
 *    id that never existed, and nothing of B (name, product title, brand, ids, buyers) is in the page source or in any answer
 *    the browser received. The same holds for forced API calls from A's session, reads and writes; B's data is read back with B's
 *    token to prove nothing changed.
 *  - A VIEWER of a shop sees no write control and gets 403 from forced write requests.
 * The server-side half (every endpoint, cursors from another shop) is in the backend end-to-end suites.
 */

const NOT_FOUND_HEADING = "We couldn't find that shop.";

/** Opens `path` and gathers everything a reader could learn from it: status, page content, source and network answers. */
async function look(page: Page, path: string) {
  const answers = recordAnswers(page);
  const response = await page.goto(path);
  const source = (await response?.text()) ?? '';
  await expect(page.locator('#main-content')).toBeVisible();
  const text = await mainText(page);
  return { status: response?.status() ?? 0, source, content: await page.content(), text, answers };
}

function expectNoneOf(needles: string[], haystacks: Record<string, string>) {
  for (const [where, haystack] of Object.entries(haystacks)) {
    for (const needle of needles) expect(haystack.includes(needle), `${where} must not contain "${needle}"`).toBe(false);
  }
}

test.describe('Seller isolation: seller A and the data of seller B', () => {
  test('B\'s shop, inventory and orders addresses give A the not-found page of an unknown id', async ({ page, browser }) => {
    const productTitle = uniqueTitle('Hidden Walnut Spoon');
    const brand = `Secret-Brand-${Date.now().toString(36)}`;
    const other = await browser.newContext();
    try {
      const pageB = await other.newPage();
      const b = await ownerWithShop(pageB, []);
      const created = await sellerCall('POST', `/api/shops/${b.shopId}/products`, { title: productTitle, brand, category: 'secret', priceMinor: 1500, quantity: 4, description: 'Only the owner sees this.' }, b.token);
      expect(created.status).toBe(201);
      const productId = created.data.id as string;
      await register(page);
      const needles = [b.shopName, productTitle, brand, b.member.email, productId, 'Only the owner sees this.'];

      for (const section of ['', 'inventory', 'orders']) {
        const theirs = await look(page, shopPath(b.shopId, section));
        const unknown = await look(page, shopPath(UNKNOWN_ID, section));
        const malformed = await look(page, shopPath('not-a-shop-id', section));
        expect(theirs.text, `/${section}`).toContain(NOT_FOUND_HEADING);
        expect(theirs.status).toBe(unknown.status);
        expect(theirs.status).toBe(malformed.status);
        expect(theirs.text).toBe(unknown.text);
        expect(theirs.text).toBe(malformed.text);
        // the shop id is in the address A typed, so it may be in the source; nothing else of B may be
        expectNoneOf(needles, { [`source of /${section}`]: theirs.source, [`content of /${section}`]: theirs.content, [`text of /${section}`]: theirs.text });
        expectNoneOf(needles, Object.fromEntries(theirs.answers.map((answer, index) => [`answer ${index} ${answer.url}`, answer.text])));
      }
    } finally {
      await other.close();
    }
  });

  test('B\'s product photos address, opened inside A\'s own shop, answers like an unknown product', async ({ page, browser }) => {
    const productTitle = uniqueTitle('Hidden Oak Board');
    const brand = `Secret-Brand-${Date.now().toString(36)}`;
    const other = await browser.newContext();
    try {
      const b = await ownerWithShop(await other.newPage(), []);
      const created = await sellerCall('POST', `/api/shops/${b.shopId}/products`, { title: productTitle, brand, category: 'secret', priceMinor: 1500, quantity: 4, description: 'Only the owner sees this.' }, b.token);
      expect(created.status).toBe(201);
      const productId = created.data.id as string;
      const a = await ownerWithShop(page, []);
      const needles = [b.shopName, productTitle, brand, productId, 'Only the owner sees this.'];

      const theirs = await look(page, shopPath(a.shopId, `products/${productId}/media`));
      await expect(page.getByRole('status', { name: 'Loading photos' })).toBeHidden();
      await expect(page.getByRole('alert').first()).toBeVisible();
      const theirsText = await mainText(page);
      const unknown = await look(page, shopPath(a.shopId, `products/${UNKNOWN_ID}/media`));
      await expect(page.getByRole('status', { name: 'Loading photos' })).toBeHidden();
      await expect(page.getByRole('alert').first()).toBeVisible();
      const unknownText = await mainText(page);

      expect(theirs.status).toBe(unknown.status);
      expect(theirsText).toBe(unknownText);
      expect(theirsText).not.toContain('Add photos');
      expectNoneOf(needles.filter((needle) => needle !== productId), { source: theirs.source, content: await page.content(), text: theirsText });
      expectNoneOf(needles, Object.fromEntries(theirs.answers.map((answer, index) => [`answer ${index} ${answer.url}`, answer.text])));
      // the product is B's and untouched
      expect(await readProduct(b.token, b.shopId, productId)).toMatchObject({ title: productTitle, quantity: 4, status: 'ACTIVE', version: 1 });
    } finally {
      await other.close();
    }
  });

  test('A\'s own inventory search never returns B\'s products', async ({ page, browser }) => {
    const productTitle = uniqueTitle('Hidden Linen Apron');
    const other = await browser.newContext();
    try {
      const b = await ownerWithShop(await other.newPage(), [{ title: productTitle, brand: 'Secret-Brand' }]);
      const a = await ownerWithShop(page, [{ title: uniqueTitle('A Own Mug') }]);
      const answers = recordAnswers(page);
      await page.goto(`${shopPath(a.shopId, 'inventory')}?q=${encodeURIComponent(productTitle)}`);
      await expect(page.getByText('Search covers all products.')).toBeVisible();
      await expect(page.getByRole('row').filter({ hasText: productTitle })).toHaveCount(0);
      await expect(page.getByText(`No products match “${productTitle}”.`)).toBeVisible();
      for (const answer of answers.filter((entry) => entry.url.includes('/products'))) {
        expect(answer.text).not.toContain('Secret-Brand');
        expect(answer.text).not.toContain(b.shopId);
      }
    } finally {
      await other.close();
    }
  });

  test('forced API calls from A\'s session answer for B\'s shop exactly as for an unknown shop, and change nothing', async ({ page, browser }) => {
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

  test('the orders of another shop: not found page, no order reference or buyer id in the page or any answer', async ({ page, browser }) => {
    const seeded = await orderInSeededShop(browser);
    const orders = await sellerCall('GET', `/api/shops/${seeded.shopId}/orders?limit=20`, undefined, seeded.token);
    expect(orders.status).toBe(200);
    const items = orders.data.items as { shopOrderId: string; buyerId?: string }[];
    expect(items.length).toBeGreaterThan(0);
    const shop = await sellerCall('GET', `/api/shops/${seeded.shopId}`, undefined, seeded.token);
    const needles = [shop.data.name as string, ...items.flatMap((item) => [item.shopOrderId.slice(-8), item.buyerId ?? ''])].filter(Boolean);

    await ownerWithShop(page, []);
    const theirs = await look(page, shopPath(seeded.shopId, 'orders'));
    const unknown = await look(page, shopPath(UNKNOWN_ID, 'orders'));
    expect(theirs.text).toContain(NOT_FOUND_HEADING);
    expect(theirs.text).toBe(unknown.text);
    expect(theirs.status).toBe(unknown.status);
    expectNoneOf(needles, { source: theirs.source, content: theirs.content, text: theirs.text });
    expectNoneOf(needles, Object.fromEntries(theirs.answers.map((answer, index) => [`answer ${index} ${answer.url}`, answer.text])));

    const read = await forced(page, 'GET', `/api/shops/${seeded.shopId}/orders`);
    const readUnknown = await forced(page, 'GET', `/api/shops/${UNKNOWN_ID}/orders`);
    expect(read.status).toBe(readUnknown.status);
    expect(read.status).toBeGreaterThanOrEqual(400);
    expectNoneOf(needles, { 'forced orders answer': read.text });
  });
});

test.describe('Seller isolation: a VIEWER has no write controls and is refused forced writes', () => {
  test('viewer: read-only inventory, photos and orders, no write button, 403 from forced requests', async ({ page, browser }) => {
    test.fixme(!(await devMailboxLists()), 'blocked: no dev outbox at /api/dev/mailbox, so a VIEWER cannot be invited (L-003)');

    const title = uniqueTitle('Viewer Mug');
    const owner = await ownerWithShop(page, [{ title, quantity: 5 }]);
    const productId = owner.productIds[0] as string;
    const before = await readProduct(owner.token, owner.shopId, productId);
    const galleryBefore = await readGallery(owner.token, owner.shopId, productId);
    const viewer = await joinShopAs(browser, owner.member, owner.shopId, 'VIEWER');
    try {
      const vp = viewer.page;
      const api = watchApi(vp);

      // inventory: the list is there, the write controls are not
      await vp.goto(shopPath(owner.shopId, 'inventory'));
      await expect(vp.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
      await expect(vp.getByRole('row').filter({ hasText: title })).toBeVisible();
      await expect(vp.getByRole('button', { name: 'Add product' })).toHaveCount(0);
      await expect(vp.getByRole('button', { name: /^Actions for / })).toHaveCount(0);

      // photos: readable by address, but no chooser, save, move or remove
      await vp.goto(shopPath(owner.shopId, `products/${productId}/media`));
      await expect(vp.getByRole('heading', { level: 1, name: 'Photos' })).toBeVisible();
      await expect(vp.getByLabel('Add photos')).toHaveCount(0);
      await expect(vp.getByRole('button', { name: 'Save photos' })).toHaveCount(0);
      await expect(vp.getByRole('button', { name: /^(Move|Remove) photo/ })).toHaveCount(0);

      // orders: readable, nothing to change
      await vp.goto(shopPath(owner.shopId, 'orders'));
      await expect(vp.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
      await expect(vp.getByText('No orders yet.')).toBeVisible();

      // pages that need a write permission show the forbidden panel, and the menu does not offer them
      await vp.goto(shopPath(owner.shopId, 'imports'));
      await expect(vp.getByRole('heading', { level: 1, name: "You don't have access to this page." })).toBeVisible();
      await expect(vp.getByText('Your role in this shop: Viewer.')).toBeVisible();
      await expect(vp.getByRole('link', { name: 'Import', exact: true })).toHaveCount(0);

      // just looking sent no write
      expect(api.writes()).toEqual([]);

      // forced requests from the viewer's session
      const forbidden = [
        await forced(vp, 'POST', `/api/shops/${owner.shopId}/products`, { title: 'Planted', brand: 'Planted', category: 'planted', priceMinor: 100, currency: 'EUR', quantity: 1 }),
        await forced(vp, 'PATCH', `/api/shops/${owner.shopId}/products/${productId}`, { expectedVersion: before.version, quantity: 999 }),
        await forced(vp, 'POST', `/api/shops/${owner.shopId}/products/${productId}/archive`, { expectedVersion: before.version }),
        await forced(vp, 'POST', `/api/shops/${owner.shopId}/products/${productId}/restore`, { expectedVersion: before.version }),
        await forced(vp, 'PUT', `/api/shops/${owner.shopId}/products/${productId}/gallery`, { mediaIds: [], expectedVersion: galleryBefore.version }),
        await forced(vp, 'POST', `/api/shops/${owner.shopId}/media/uploads`, { purpose: 'product' }),
      ];
      expect(forbidden.map((answer) => answer.status)).toEqual([403, 403, 403, 403, 403, 403]);

      // and nothing changed
      expect(await readProduct(owner.token, owner.shopId, productId)).toEqual(before);
      expect(await listProducts(owner.token, owner.shopId)).toHaveLength(1);
      expect(await readGallery(owner.token, owner.shopId, productId)).toEqual(galleryBefore);
    } finally {
      await viewer.context.close();
    }
  });

  test('a person who is not a member of the shop is sent to sign in, not shown the shop', async ({ page, browser }) => {
    const owner = await ownerWithShop(page, []);
    const stranger = await browser.newContext();
    try {
      const strangerPage = await stranger.newPage();
      const response = await strangerPage.goto(shopPath(owner.shopId, 'inventory'));
      expect(response?.status()).toBeLessThan(500);
      await expect(strangerPage).toHaveURL(/\/login\?returnTo=/);
      expect(await strangerPage.content()).not.toContain(owner.shopName);
      // a signed-in person with no shop is a stranger too
      await register(strangerPage, uniqueEmail('stranger'));
      await strangerPage.goto(shopPath(owner.shopId, 'inventory'));
      await expect(strangerPage.getByText(NOT_FOUND_HEADING)).toBeVisible();
      expect(await strangerPage.content()).not.toContain(owner.shopName);
    } finally {
      await stranger.close();
    }
  });
});
