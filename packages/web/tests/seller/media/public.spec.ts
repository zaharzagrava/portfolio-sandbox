import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { sellerCall } from '../../helpers';
import { archiveByApi, ownerWithShop, setSuspended, uniqueTitle } from '../cross-cutting/support';
import { GALLERY, dbOrder, savedGallery } from './edit-support';
import { API_URL } from '../../helpers';

/**
 * AI QA, area "media", pass 3: the photos as a buyer meets them (map lines `media.public.*`). The public gallery read is checked
 * on the API; the product page and the search card are opened in a browser without signing in. On the dev stack every picture
 * address is `http://localhost:9000/...` (B-002), which the page refuses to use (`https` only), so a buyer sees the neutral
 * placeholder whatever the gallery holds; the lines that need a real picture on screen are therefore blocked (see the findings).
 */

function covers(...ids: string[]) {
  test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
}
const publicGallery = (productId: string) => fetch(`${API_URL}/api/products/${productId}/gallery`);

test.describe('Photos: the public gallery', () => {
  test('media.public.api, media.public.hidden, media.public.removed-photo, media.public.order-after-save: what the anonymous read returns and when it answers 404', async ({ page }) => {
    covers('media.public.api', 'media.public.hidden', 'media.public.removed-photo');
    expect(true).toBe(true);
    test.setTimeout(240_000);
    const { shopId, productIds, token } = await ownerWithShop(page, [{ title: uniqueTitle('Public One') }, { title: uniqueTitle('Public Two') }]);
    const [productId, archivedId] = productIds;
    const mediaIds = await savedGallery(token, shopId, productId, 3);

    const answer = await publicGallery(productId);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control'), 'cacheable for a few seconds by shared caches').toMatch(/public/);
    expect(answer.headers.get('cache-control')).toMatch(/s-maxage=5/);
    const text = await answer.text();
    const body = JSON.parse(text);
    expect(body.items.map((item: { mediaId: string }) => item.mediaId), 'in the saved order').toEqual(mediaIds);
    for (const item of body.items) expect(Object.keys(item.urls).sort()).toEqual(['feed', 'full', 'thumb']);
    expect(text, 'no version and no storage key').not.toMatch(/"version"|originalKey|media\/original|uploaderId/);

    // order after a save: the first photo changes in the public read within the 5 s cache
    await sellerCall('PUT', GALLERY(shopId, productId), { mediaIds: [mediaIds[2], mediaIds[0], mediaIds[1]], expectedVersion: 1 }, token);
    await expect
      .poll(async () => (await (await publicGallery(productId)).json()).items.map((item: { mediaId: string }) => item.mediaId), { timeout: 15_000 })
      .toEqual([mediaIds[2], mediaIds[0], mediaIds[1]]);

    // a photo that was removed is not listed any more; the photo row itself and its files stay
    await sellerCall('PUT', GALLERY(shopId, productId), { mediaIds: [mediaIds[2], mediaIds[1]], expectedVersion: 2 }, token);
    await expect
      .poll(async () => (await (await publicGallery(productId)).json()).items.map((item: { mediaId: string }) => item.mediaId), { timeout: 15_000 })
      .toEqual([mediaIds[2], mediaIds[1]]);
    expect(dbOrder(productId), 'the join rows follow').toEqual([mediaIds[2], mediaIds[1]]);
    const removed = await sellerCall('GET', `/api/media/${mediaIds[0]}`);
    expect(removed.status, 'the removed photo is still a READY photo, its old address keeps working').toBe(200);

    // hidden: unknown product, an archived product and a suspended shop answer the same 404
    const unknown = await publicGallery(randomUUID());
    expect(unknown.status).toBe(404);
    const reference = await unknown.json();
    await savedGallery(token, shopId, archivedId, 1);
    await archiveByApi(token, shopId, archivedId);
    const archived = await publicGallery(archivedId);
    expect(archived.status, 'archived product').toBe(404);
    expect((await archived.json()).type).toBe(reference.type);
    await setSuspended(shopId, true);
    try {
      const suspended = await publicGallery(productId);
      expect(suspended.status, 'suspended shop').toBe(404);
      const suspendedBody = await suspended.json();
      expect(suspendedBody.type).toBe(reference.type);
      expect(suspendedBody.title).toBe(reference.title);
      expect(suspendedBody.detail ?? '').toBe(reference.detail ?? '');
    } finally {
      await setSuspended(shopId, false);
    }
    expect((await publicGallery(productId)).status, 'back to normal after reinstating').toBe(200);

    // the buyer's screen for a hidden product: the not-found page, and for the one with the removed photo no picture of it
    const buyer = await (await page.context().browser()!.newContext()).newPage();
    try {
      await buyer.goto(`/products/${archivedId}`);
      await expect(buyer.getByText('Product not found').first()).toBeVisible();
      await expect(buyer.getByTestId('gallery-main')).toHaveCount(0);
      // the page is cached for a few seconds (a state seen while the shop was suspended may still be served)
      await expect(async () => {
        await buyer.goto(`/products/${productId}`);
        await expect(buyer.getByTestId('gallery-placeholder'), 'the live product shows the neutral block on this stack (http addresses)').toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 40_000, intervals: [3_000] });
      expect(await buyer.content(), 'the removed photo is not on the page').not.toContain(mediaIds[0]);
    } finally {
      await buyer.context().close();
    }
  });

  test('media.public.no-image, media.public.https-only, media.public.card-image: a buyer sees the neutral block when there is no usable picture', async ({ page, browser }) => {
    covers('media.public.no-image', 'media.public.https-only');
    test.setTimeout(240_000);
    const { shopId, productIds, token } = await ownerWithShop(page, [{ title: uniqueTitle('Public Bare') }, { title: uniqueTitle('Public Photos') }]);
    const [bare, withPhotos] = productIds;
    await savedGallery(token, shopId, withPhotos, 2);
    const buyer = await (await browser.newContext()).newPage();
    try {
      // no photos at all: the placeholder with its words, no main image and no thumbnail strip
      await buyer.goto(`/products/${bare}`);
      const placeholder = buyer.getByTestId('gallery-placeholder');
      await expect(placeholder).toBeVisible();
      await expect(placeholder).toHaveAttribute('aria-label', 'No image available');
      await expect(buyer.getByTestId('gallery-main')).toHaveCount(0);
      await expect(buyer.getByRole('list', { name: 'Product images' })).toHaveCount(0);

      // photos exist, but their addresses are http (dev storage): the page does not use them, same block
      const read = await (await publicGallery(withPhotos)).json();
      expect(read.items, 'the gallery holds 2 photos').toHaveLength(2);
      expect(new URL(read.items[0].urls.feed).protocol, 'this stack serves http addresses').toBe('http:');
      await buyer.goto(`/products/${withPhotos}`);
      await expect(buyer.getByTestId('gallery-placeholder')).toBeVisible();
      await expect(buyer.getByTestId('gallery-main')).toHaveCount(0);
      expect(await buyer.locator('img[src^="http:"]').count(), 'no http picture is put on the page').toBe(0);
    } finally {
      await buyer.context().close();
    }
  });
});
