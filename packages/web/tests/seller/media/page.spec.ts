import { expect, test, type Page } from '@playwright/test';
import { sellerCall, shopPath } from '../../helpers';
import { UNKNOWN_ID, archiveByApi, devMailboxLists, joinShopAs, openSecondShop, ownerWithShop, uniqueTitle, watchApi } from '../cross-cutting/support';
import { fillGallery, photosOf } from './support';

/**
 * AI QA, area "media", the page itself (map lines `media.page.*`): the address, who may open it, the states while it loads and
 * fails, the way in from the inventory, the layout at three widths, and an archived product. The upload lines are in
 * `media-upload.spec.ts`. Every test names the map lines it covers in its title and in the `aiqa-lines` annotation; the
 * result of a run is written to `scripts/aiqa/coverage/media.tsv` with `scripts/aiqa/mark.mjs`.
 *
 * Each test makes its own seller, shop and product, so the file can run next to the other specs on the shared stack.
 */

const mediaPath = (shopId: string, productId: string) => `${shopPath(shopId, 'products')}/${productId}/media`;
const NOT_FOUND = "We couldn't find that shop.";
const PRODUCT_NOT_FOUND = "We couldn't find that product.";
const galleryRoute = (shopId: string, productId: string) => new RegExp(`^/api/shops/${shopId}/products/${productId}/gallery$`);

function covers(...ids: string[]) {
  test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
}

/** The number of columns of the photo grid, as the browser laid it out. */
const columnsOf = (page: Page) => page.getByRole('list', { name: 'Photos' }).evaluate((list) => getComputedStyle(list).gridTemplateColumns.split(' ').length);

test.describe('Photos page: address, states and layout', () => {
  test('media.page.route, media.page.tab.photos, media.page.intro-text, media.page.counter, media.page.empty: an empty product', async ({ page }) => {
    covers('media.page.route', 'media.page.tab.photos', 'media.page.intro-text', 'media.page.counter', 'media.page.empty');
    const { shopId, productIds } = await ownerWithShop(page, [{ title: uniqueTitle('Empty Gallery') }]);
    const api = watchApi(page);
    await page.goto(mediaPath(shopId, productIds[0]));

    await expect(page.getByRole('heading', { level: 1, name: 'Photos' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to inventory' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Photos' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('link', { name: 'Video' })).not.toHaveAttribute('aria-current', 'page');
    await expect(page.getByText("The first photo is the product's main image. Changes apply when you save.")).toBeVisible();
    await expect(page.getByText('0 of 20 photos')).toBeVisible();
    await expect(page.getByText('No photos yet. Add the first one.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save photos' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Discard changes' })).toHaveCount(0);

    // one read of the member's gallery, answered 200 (the empty gallery has version 0 and no items)
    expect(api.matching('GET', galleryRoute(shopId, productIds[0])).map((entry) => entry.status)).toEqual([200]);
  });

  test('media.page.back-link, media.page.tab.video: the two links leave the page to the right addresses', async ({ page }) => {
    covers('media.page.back-link', 'media.page.tab.video');
    const { shopId, productIds } = await ownerWithShop(page, [{ title: uniqueTitle('Links') }]);
    await page.goto(mediaPath(shopId, productIds[0]));
    await expect(page.getByRole('link', { name: 'Back to inventory' })).toHaveAttribute('href', shopPath(shopId, 'inventory'));
    await expect(page.getByRole('link', { name: 'Video' })).toHaveAttribute('href', `${mediaPath(shopId, productIds[0])}/video`);

    await page.getByRole('link', { name: 'Video' }).click();
    await expect(page).toHaveURL(`${mediaPath(shopId, productIds[0])}/video`);
    await page.goBack();
    await page.getByRole('link', { name: 'Back to inventory' }).click();
    await expect(page).toHaveURL(shopPath(shopId, 'inventory'));
  });

  test('media.page.counter, media.page.desktop-grid, media.page.mobile-390: the grid and its buttons at three widths', async ({ page }) => {
    covers('media.page.counter', 'media.page.desktop-grid', 'media.page.mobile-390');
    test.setTimeout(120_000);
    const { shopId, productIds, token } = await ownerWithShop(page, [{ title: uniqueTitle('Grid') }]);
    await fillGallery(token, shopId, productIds[0], 4);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(mediaPath(shopId, productIds[0]));
    await expect(photosOf(page)).toHaveCount(4);
    await expect(page.getByText('4 of 20 photos')).toBeVisible();
    expect(await columnsOf(page)).toBe(4);

    await page.setViewportSize({ width: 700, height: 800 });
    await expect.poll(() => columnsOf(page)).toBe(2);

    await page.setViewportSize({ width: 390, height: 800 });
    await expect.poll(() => columnsOf(page)).toBe(1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'no sideways scroll at 390 px').toBeLessThanOrEqual(0);
    // the three buttons of a card are at least 44 px square on a phone
    for (const name of ['Move photo 2 up', 'Move photo 2 down', 'Remove photo 2']) {
      // the buttons animate their size when the width changes (transition-all), so wait for the end of it
      const button = page.getByRole('button', { name });
      await expect.poll(async () => (await button.boundingBox())?.width, { message: `${name}: width` }).toBeGreaterThanOrEqual(44);
      await expect.poll(async () => (await button.boundingBox())?.height, { message: `${name}: height` }).toBeGreaterThanOrEqual(44);
    }
    const chooser = await page.getByLabel('Add photos').boundingBox();
    expect((chooser?.x ?? 0) + (chooser?.width ?? 999)).toBeLessThanOrEqual(390);

    // the counter follows the draft, not only the saved list
    await page.getByRole('button', { name: 'Remove photo 4' }).click();
    await expect(page.getByText('3 of 20 photos')).toBeVisible();
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.getByText('4 of 20 photos')).toBeVisible();
  });

  test('media.page.not-signed-in: a signed-out visitor is sent to sign-in and comes back to the photos page', async ({ page, browser }) => {
    covers('media.page.not-signed-in');
    const { shopId, productIds } = await ownerWithShop(page, [{ title: uniqueTitle('Signed Out') }]);
    const visitor = await browser.newContext();
    try {
      const anonymous = await visitor.newPage();
      await anonymous.goto(mediaPath(shopId, productIds[0]));
      await expect(anonymous).toHaveURL(/\/login\?/);
      // W04 AS-84: returnTo is "that path", not the shop's home
      expect(new URL(anonymous.url()).searchParams.get('returnTo')).toBe(mediaPath(shopId, productIds[0]));
    } finally {
      await visitor.close();
    }
  });

  test('media.page.bad-product-id: a product id that is no uuid shows the not-found page and asks for no gallery', async ({ page }) => {
    covers('media.page.bad-product-id');
    const { shopId } = await ownerWithShop(page, []);
    const api = watchApi(page);
    await page.goto(mediaPath(shopId, 'not-a-uuid'));
    await expect(page.getByText(PRODUCT_NOT_FOUND)).toBeVisible();
    expect(api.seen.filter((entry) => /\/gallery$/.test(entry.path))).toEqual([]);
  });

  test('media.page.unknown-shop: an unknown shop id and another seller\'s shop give a real 404 and no gallery request', async ({ page, browser }) => {
    covers('media.page.unknown-shop');
    const own = await ownerWithShop(page, [{ title: uniqueTitle('Own') }]);
    const other = await browser.newContext();
    try {
      const otherPage = await other.newPage();
      const theirs = await ownerWithShop(otherPage, [{ title: uniqueTitle('Theirs') }]);
      const api = watchApi(page);
      for (const [label, path] of [
        ['unknown shop', mediaPath(UNKNOWN_ID, own.productIds[0])],
        ['other seller shop', mediaPath(theirs.shopId, theirs.productIds[0])],
      ] as const) {
        const response = await page.goto(path);
        await expect(page.getByText(NOT_FOUND), label).toBeVisible();
        // W04 FR-001: a non-member gets "a real not-found response", not a 200 page that says so
        expect(response?.status(), `${label}: status of the page`).toBe(404);
      }
      expect(api.seen.filter((entry) => /\/gallery$/.test(entry.path))).toEqual([]);
    } finally {
      await other.close();
    }
  });

  test('media.page.unknown-product, media.page.foreign-product: a missing product and a product of another shop answer the same 404', async ({ page }) => {
    covers('media.page.unknown-product', 'media.page.foreign-product');
    const first = await ownerWithShop(page, [{ title: uniqueTitle('First') }]);
    const second = await openSecondShop(first.member);
    const foreignId = (await sellerCall('POST', `/api/shops/${second.shopId}/products`, { title: uniqueTitle('Other Shop Item'), brand: 'Test', category: 'x', priceMinor: 1000, quantity: 1, description: 'x' }, first.token)).data.id as string;
    const api = watchApi(page);

    const seen: string[] = [];
    for (const productId of [UNKNOWN_ID, foreignId]) {
      api.reset();
      await page.goto(mediaPath(first.shopId, productId));
      await expect(page.getByText(PRODUCT_NOT_FOUND)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Try again' }), 'a 404 cannot succeed on retry').toHaveCount(0);
      seen.push(await page.locator('#main-content').innerText());
      expect(api.matching('GET', galleryRoute(first.shopId, productId)).map((entry) => entry.status), 'one read, answered 404 (no retry on a client error)').toEqual([404]);
      await expect(page.getByRole('list', { name: 'Photos' })).toHaveCount(0);
      await expect(page.getByLabel('Add photos')).toHaveCount(0);
    }
    expect(seen[0], 'a product of another shop reads exactly like one that never existed').toBe(seen[1]);
  });

  test('media.page.loading, media.page.load-error: a loading box, then an error panel whose Try again fetches again', async ({ page }) => {
    covers('media.page.loading', 'media.page.load-error');
    const { shopId, productIds } = await ownerWithShop(page, [{ title: uniqueTitle('Slow') }]);
    let failing = true;
    await page.route(`**/api/shops/${shopId}/products/${productIds[0]}/gallery`, async (route) => {
      if (route.request().method() !== 'GET' || !failing) return route.continue();
      await new Promise((resolve) => setTimeout(resolve, 800));
      return route.fulfill({ status: 500, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: 'Internal Server Error', status: 500 }) });
    });
    await page.goto(mediaPath(shopId, productIds[0]));
    await expect(page.getByRole('status', { name: 'Loading photos' })).toBeVisible();

    const retry = page.getByRole('button', { name: 'Try again' });
    await expect(retry).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Something went wrong on our side.')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Photos' })).toHaveCount(0);

    failing = false;
    await retry.click();
    await expect(page.getByText('0 of 20 photos')).toBeVisible();
    await expect(page.getByText('No photos yet. Add the first one.')).toBeVisible();
  });

  test('media.page.access.viewer: every built-in role holds products.read, so no member is shut out of the page', async ({ page }) => {
    covers('media.page.access.viewer');
    const { token } = await ownerWithShop(page, []);
    const roles = await sellerCall('GET', '/api/shop-roles', undefined, token);
    expect(roles.status).toBe(200);
    for (const [role, permissions] of Object.entries(roles.data.roles as Record<string, string[]>)) {
      expect(permissions, `${role} reads products`).toContain('products.read');
    }
  });

  test('media.page.entry.inventory-menu, media.page.entry.archived-product: the menu entry is for active products and writers only', async ({ page, browser }) => {
    covers('media.page.entry.inventory-menu', 'media.page.entry.archived-product');
    test.fixme(!(await devMailboxLists()), 'blocked: no dev outbox at /api/dev/mailbox, so a VIEWER cannot be invited');
    const live = uniqueTitle('Menu Live');
    const old = uniqueTitle('Menu Archived');
    const { shopId, productIds, token, member } = await ownerWithShop(page, [{ title: live }, { title: old }]);
    await archiveByApi(token, shopId, productIds[1]);

    await page.goto(shopPath(shopId, 'inventory'));
    await page.getByRole('button', { name: `Actions for ${live}` }).click();
    await expect(page.getByRole('menuitem', { name: 'Photos and video' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Photos and video' }).click();
    await expect(page).toHaveURL(mediaPath(shopId, productIds[0]));

    await page.goto(`${shopPath(shopId, 'inventory')}?status=ARCHIVED`);
    await page.getByRole('button', { name: `Actions for ${old}` }).click();
    await expect(page.getByRole('menuitem', { name: 'Restore' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Photos and video' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // a VIEWER has no row menu at all, but may open the photos page by address (read only)
    const viewer = await joinShopAs(browser, member, shopId, 'VIEWER');
    try {
      await viewer.page.goto(shopPath(shopId, 'inventory'));
      await expect(viewer.page.getByRole('row').filter({ hasText: live })).toBeVisible();
      await expect(viewer.page.getByRole('button', { name: `Actions for ${live}` })).toHaveCount(0);
    } finally {
      await viewer.context.close();
    }
  });

  test('media.page.entry.archived-product: an archived product opened by address lists its photos but refuses to save, and says so truthfully', async ({ page }) => {
    covers('media.page.entry.archived-product');
    test.setTimeout(120_000);
    const { shopId, productIds, token } = await ownerWithShop(page, [{ title: uniqueTitle('Archived Photos') }]);
    await fillGallery(token, shopId, productIds[0], 2);
    await archiveByApi(token, shopId, productIds[0]);
    const api = watchApi(page);
    await page.goto(mediaPath(shopId, productIds[0]));
    await expect(photosOf(page)).toHaveCount(2);

    await page.getByRole('button', { name: 'Remove photo 2' }).click();
    await page.getByRole('button', { name: 'Save photos' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /archived/i })).toBeVisible();
    expect(api.matching('PUT', galleryRoute(shopId, productIds[0])).map((entry) => entry.status)).toEqual([409]);
    // S29.R-19: nothing was saved
    const saved = await sellerCall('GET', `/api/shops/${shopId}/products/${productIds[0]}/gallery`, undefined, token);
    expect(saved.data.items).toHaveLength(2);
    // the sentence says "The list has been refreshed": then the page must have read the gallery again and dropped the draft
    await expect.poll(() => api.count('GET', galleryRoute(shopId, productIds[0])), { message: 'the promised refresh' }).toBeGreaterThanOrEqual(2);
    await expect(page.getByText('2 of 20 photos')).toBeVisible();
  });
});
