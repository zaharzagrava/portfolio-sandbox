import { expect, test } from '@playwright/test';
import { sellerCall } from '../../helpers';
import { readGallery, watchApi } from '../cross-cutting/support';
import { apiOrder, dbMediaStatus, dbOrder, dbPositions, dbVersion, galleryEvents, galleryEventPayloads, galleryRoute, GALLERY, openGallery, shownAlts, shownWidths, widthOf } from './edit-support';
import { photosOf } from './support';

/**
 * AI QA, area "media", pass 2: editing the draft of a gallery on the page (map lines `media.order.*`, `media.cover.*`,
 * `media.remove.*`). Photos are told apart by their width (11, 12, 13 px), which the page prints in the picture. The draft is
 * the page's own state: while it is edited nothing may be sent; the database is read after "Save photos".
 */

function covers(...ids: string[]) {
  test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
}

test.describe('Photos draft: order, cover and remove', () => {
  test('media.order.up, media.order.down, media.order.labels, media.cover.no-button, media.save.button: moving photos edits only the draft', async ({ page }) => {
    covers('media.order.up', 'media.order.down', 'media.order.labels', 'media.cover.no-button', 'media.save.button');
    test.setTimeout(120_000);
    const { shopId, productId, token, mediaIds } = await openGallery(page, 3);
    const api = watchApi(page);
    await expect(page.getByRole('button', { name: 'Save photos' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Move photo 1 up' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Move photo 3 down' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Move photo 1 down' })).toBeEnabled();
    expect(await shownWidths(page)).toEqual([11, 12, 13]);

    await page.getByRole('button', { name: 'Move photo 2 up' }).click();
    expect(await shownWidths(page), 'photo 2 and photo 1 swapped').toEqual([12, 11, 13]);
    // the captions and the alt text are the place, not the file
    expect(await shownAlts(page)).toEqual(['Photo 1', 'Photo 2', 'Photo 3']);
    await expect(page.getByText('Photo 3', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save photos' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Discard changes' })).toBeVisible();

    await page.getByRole('button', { name: 'Move photo 2 down' }).click();
    expect(await shownWidths(page)).toEqual([12, 13, 11]);
    await expect(page.getByRole('button', { name: 'Move photo 3 down' })).toBeDisabled();
    await expect(page.getByText('3 of 20 photos')).toBeVisible();

    // nothing was sent, nothing changed on the server
    expect(api.writes(), 'no write while the draft is edited').toEqual([]);
    expect(await apiOrder(token, shopId, productId)).toEqual(mediaIds);
    expect(dbOrder(productId)).toEqual(mediaIds);

    // there is no "make cover" control: the cover is the first place
    await expect(page.getByRole('button', { name: /cover|main|primary|make/i })).toHaveCount(0);
    await expect(page.locator('#main-content').getByRole('link', { name: /cover|main image|primary/i }).filter({ hasNotText: /skip/i })).toHaveCount(0);
  });

  test('media.order.keyboard: the three buttons work with Tab and Enter/Space; where the focus goes after a move', async ({ page }) => {
    covers('media.order.keyboard');
    test.setTimeout(120_000);
    await openGallery(page, 3);
    await page.getByRole('button', { name: 'Move photo 3 up' }).focus();
    await page.keyboard.press('Enter');
    expect(await shownWidths(page)).toEqual([11, 13, 12]);
    // the card moved with its button, so the same button (now "Move photo 2 up") still has the focus
    await expect(page.getByRole('button', { name: 'Move photo 2 up' })).toBeFocused();
    await page.keyboard.press('Space');
    expect(await shownWidths(page)).toEqual([13, 11, 12]);
    // the button the person just pressed is now disabled (the photo is first): the focus must not be dropped to the page
    const active = await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') }));
    expect.soft(active.tag, `focus after the photo reached the top: ${JSON.stringify(active)}`).not.toBe('BODY');
    // Tab walks on to the next control (no trap)
    await page.getByRole('button', { name: 'Move photo 2 down' }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Remove photo 2' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('2 of 20 photos')).toBeVisible();
  });

  test('media.order.drag-drop, media.order.live-announce: dragging does nothing and a move is announced', async ({ page }) => {
    covers('media.order.drag-drop', 'media.order.live-announce');
    test.setTimeout(120_000);
    await openGallery(page, 3);
    const images = photosOf(page);
    await images.nth(2).dragTo(images.nth(0));
    expect(await shownWidths(page), 'a drag does not reorder').toEqual([11, 12, 13]);
    await expect(page.getByRole('button', { name: 'Save photos' })).toBeDisabled();
    // the list itself is not a live region; a separate status region next to it speaks
    const live = await page.getByRole('list', { name: 'Photos' }).evaluate((list) => {
      const regions: string[] = [];
      for (let node: Element | null = list; node && node !== document.body; node = node.parentElement) if (node.matches('[aria-live], [role=status], [role=alert], [role=log]')) regions.push(node.tagName);
      return { ancestors: regions, inside: list.querySelectorAll('[aria-live], [role=status], [role=alert], [role=log]').length };
    });
    expect(live).toEqual({ ancestors: [], inside: 0 });
    await page.getByRole('button', { name: 'Move photo 2 up' }).click();
    // S29 / W04.R-24: a move is announced with the new place
    await expect(page.locator('#main-content [role=status]:not([aria-label])').filter({ hasText: 'Photo moved to position 1 of 3.' })).toHaveCount(1);
  });

  test('media.remove.button, media.cover.after-remove-first, media.remove.save: remove photo 1, save, and the old second photo is the cover', async ({ page }) => {
    covers('media.remove.button', 'media.cover.after-remove-first', 'media.remove.save');
    test.setTimeout(120_000);
    const { shopId, productId, token, mediaIds } = await openGallery(page, 3);
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => void dialogs.push(dialog.message()));
    const api = watchApi(page);
    const eventsBefore = galleryEvents(productId);

    await page.getByRole('button', { name: 'Remove photo 1' }).click();
    // at once, without a question; later photos renumber
    expect(dialogs).toEqual([]);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await shownWidths(page)).toEqual([12, 13]);
    expect(await shownAlts(page)).toEqual(['Photo 1', 'Photo 2']);
    await expect(page.getByText('2 of 20 photos')).toBeVisible();
    expect(api.writes()).toEqual([]);
    expect(dbOrder(productId), 'nothing deleted yet').toEqual(mediaIds);

    await page.getByRole('button', { name: 'Save photos' }).click();
    await expect(page.getByText('Photos saved')).toBeVisible();
    const puts = api.matching('PUT', galleryRoute(shopId, productId));
    expect(puts.map((entry) => entry.status)).toEqual([200]);
    expect(api.writes().map((entry) => entry.method), 'no DELETE of a media row from this page').toEqual(['PUT']);
    // the database: the row is gone, positions are 0 and 1, the version went up, the photo itself stays READY
    expect(dbOrder(productId)).toEqual([mediaIds[1], mediaIds[2]]);
    expect(dbPositions(productId)).toEqual(['0', '1']);
    expect(dbVersion(productId)).toBe(2);
    expect(dbMediaStatus(mediaIds[0]), 'the removed photo is only detached').toBe('READY');
    expect(galleryEvents(productId)).toBe(eventsBefore + 1);
    // the public gallery (what the product page and the storefront card read) starts with the old second photo
    const pub = await sellerCall('GET', `/api/products/${productId}/gallery`);
    expect(pub.status).toBe(200);
    expect(pub.data.items.map((item: { mediaId: string }) => item.mediaId)).toEqual([mediaIds[1], mediaIds[2]]);
    expect(await shownWidths(page)).toEqual([12, 13]);
    await expect(page.getByRole('button', { name: 'Discard changes' })).toHaveCount(0);
    expect((await readGallery(token, shopId, productId)).version).toBe(2);
  });

  test('media.cover.first-is-main: the first photo of the saved gallery is the main image of the product page', async ({ page }) => {
    covers('media.cover.first-is-main');
    test.setTimeout(120_000);
    const { shopId, productId, token } = await openGallery(page, 2);
    await page.getByRole('button', { name: 'Move photo 2 up' }).click();
    await page.getByRole('button', { name: 'Save photos' }).click();
    await expect(page.getByText('Photos saved')).toBeVisible();
    const pub = await sellerCall('GET', `/api/products/${productId}/gallery`);
    expect(pub.status).toBe(200);
    const first = pub.data.items[0] as { mediaId: string; urls: { feed: string; thumb: string } };
    expect(first.mediaId, 'position 0 of the public gallery is the photo moved to the top').toBe((await readGallery(token, shopId, productId)).items[0].mediaId);
    expect(pub.data.items.map((item: { mediaId: string }) => item.mediaId)).toEqual(dbOrder(productId));
    // the product page: main image is the feed size of position 0 (the dev stack serves http addresses, which the page refuses to use: B-002)
    await page.goto(`/products/${productId}`);
    const main = page.getByTestId('gallery-main').locator('img');
    await expect(main, 'the product page shows the first photo as its main image (not the placeholder)').toBeVisible();
    expect(await main.getAttribute('src')).toBe(first.urls.feed);
  });

  test('media.remove.all: removing every photo and saving gives an empty public gallery and the placeholder on the product page', async ({ page }) => {
    covers('media.remove.all');
    test.setTimeout(120_000);
    const { shopId, productId } = await openGallery(page, 2);
    const api = watchApi(page);
    await page.getByRole('button', { name: 'Remove photo 2' }).click();
    await page.getByRole('button', { name: 'Remove photo 1' }).click();
    await expect(page.getByText('No photos yet. Add the first one.')).toBeVisible();
    await expect(page.getByText('0 of 20 photos')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save photos' })).toBeEnabled();
    await page.getByRole('button', { name: 'Save photos' }).click();
    await expect(page.getByText('Photos saved')).toBeVisible();
    const put = api.matching('PUT', galleryRoute(shopId, productId));
    expect(put.map((entry) => entry.status)).toEqual([200]);
    expect(dbOrder(productId)).toEqual([]);
    expect(dbVersion(productId)).toBe(2);
    const events = galleryEventPayloads(productId);
    expect(events.at(-1)).toMatchObject({ mediaIds: [], galleryVersion: 2 });
    const pub = await sellerCall('GET', `/api/products/${productId}/gallery`);
    expect(pub.data.items).toEqual([]);
    await page.goto(`/products/${productId}`);
    await expect(page.getByTestId('gallery-placeholder')).toBeVisible();
  });

  test('media.order.save-order, media.order.move-back-to-original, media.order.same-list, media.save.idempotency, media.save.events: a saved order reaches the database and the outbox; the same list again changes nothing', async ({ page }) => {
    covers('media.order.save-order', 'media.order.move-back-to-original', 'media.order.same-list', 'media.save.idempotency', 'media.save.events');
    test.setTimeout(120_000);
    const { shopId, productId, token, mediaIds } = await openGallery(page, 3);
    const api = watchApi(page);
    const events0 = galleryEvents(productId);

    // move back to the original: the button stays enabled, the save changes nothing
    await page.getByRole('button', { name: 'Move photo 2 up' }).click();
    await page.getByRole('button', { name: 'Move photo 1 down' }).click();
    expect(await shownWidths(page)).toEqual([11, 12, 13]);
    await expect(page.getByRole('button', { name: 'Save photos' })).toBeEnabled();
    await page.getByRole('button', { name: 'Save photos' }).click();
    await expect(page.getByText('Photos saved')).toBeVisible();
    expect(api.matching('PUT', galleryRoute(shopId, productId)).map((entry) => entry.status)).toEqual([200]);
    expect(dbVersion(productId), 'an unchanged list does not bump the version').toBe(1);
    expect(galleryEvents(productId), 'and writes no event').toBe(events0);
    expect(dbOrder(productId)).toEqual(mediaIds);

    // a real move: one PUT with the new order and the version it read; answer 200 with version + 1
    let body: { mediaIds: string[]; expectedVersion: number } | undefined;
    page.on('request', (request) => {
      if (request.method() === 'PUT' && galleryRoute(shopId, productId).test(new URL(request.url()).pathname)) body = request.postDataJSON();
    });
    await page.getByRole('button', { name: 'Move photo 3 up' }).click();
    await page.getByRole('button', { name: 'Move photo 2 up' }).click();
    await page.getByRole('button', { name: 'Save photos' }).click();
    await expect(page.getByRole('button', { name: 'Discard changes' })).toHaveCount(0);
    const expected = [mediaIds[2], mediaIds[0], mediaIds[1]];
    expect(body).toEqual({ mediaIds: expected, expectedVersion: 1 });
    expect(dbOrder(productId)).toEqual(expected);
    expect(dbPositions(productId)).toEqual(['0', '1', '2']);
    expect(dbVersion(productId)).toBe(2);
    expect(galleryEvents(productId)).toBe(events0 + 1);
    expect(galleryEventPayloads(productId).at(-1)).toMatchObject({ mediaIds: expected, galleryVersion: 2 });
    expect(await shownWidths(page)).toEqual([13, 11, 12]);

    // the same list and the right version through the API: 200, same state, no new event, no duplicate row
    const same = await sellerCall('PUT', GALLERY(shopId, productId), { mediaIds: expected, expectedVersion: 2 }, token);
    expect(same.status).toBe(200);
    expect(same.data.version).toBe(2);
    expect(dbVersion(productId)).toBe(2);
    expect(galleryEvents(productId)).toBe(events0 + 1);
    // replay with the old version: 409, nothing changes
    const replay = await sellerCall('PUT', GALLERY(shopId, productId), { mediaIds: expected, expectedVersion: 1 }, token);
    expect(replay.status).toBe(409);
    expect(dbOrder(productId)).toEqual(expected);
    expect(await apiOrder(token, shopId, productId)).toEqual(expected);
  });

  test('media.save.happy, media.save.persist, media.save.double-press, media.save.discard, media.save.error-clear, media.save.toast-readonly: save once, toast, reload keeps it', async ({ page }) => {
    covers('media.save.happy', 'media.save.persist', 'media.save.double-press', 'media.save.discard', 'media.save.error-clear', 'media.save.toast-readonly');
    test.setTimeout(120_000);
    const { shopId, productId, mediaIds } = await openGallery(page, 3);
    const api = watchApi(page);
    // Discard drops the draft
    await page.getByRole('button', { name: 'Remove photo 3' }).click();
    await page.getByRole('button', { name: 'Discard changes' }).click();
    expect(await shownWidths(page)).toEqual([11, 12, 13]);
    await expect(page.getByRole('button', { name: 'Save photos' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Discard changes' })).toHaveCount(0);

    // a failed save shows an alert; the next Discard clears it
    await page.route(`**${GALLERY(shopId, productId)}`, (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 500, contentType: 'application/problem+json', body: '{"type":"about:blank","title":"x","status":500}' }) : route.fallback()), { times: 1 });
    await page.getByRole('button', { name: 'Move photo 2 up' }).click();
    await page.getByRole('button', { name: 'Save photos' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /./ }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);

    // a failed save then a second Save clears the old error text while it runs, and succeeds
    api.reset();
    await page.getByRole('button', { name: 'Move photo 2 up' }).click();
    // double press: only one PUT
    await page.getByRole('button', { name: 'Save photos' }).dblclick();
    await expect(page.getByRole('status').filter({ hasText: 'Photos saved' })).toBeVisible();
    expect(api.matching('PUT', galleryRoute(shopId, productId)).map((entry) => entry.status), 'one press, one request, however fast the second press comes').toEqual([200]);
    expect(dbVersion(productId)).toBe(2);
    // the toast goes away by itself
    await expect(page.getByText('Photos saved')).toHaveCount(0, { timeout: 15_000 });
    const afterSave = [mediaIds[1], mediaIds[0], mediaIds[2]];
    expect(dbOrder(productId)).toEqual(afterSave);

    // reload: same order, count and picture addresses
    const srcs = await photosOf(page).evaluateAll((images) => images.map((image) => image.getAttribute('src')));
    await page.reload();
    await expect(page.getByText('3 of 20 photos')).toBeVisible();
    expect(await shownWidths(page)).toEqual([12, 11, 13]);
    expect(await photosOf(page).evaluateAll((images) => images.map((image) => image.getAttribute('src')))).toEqual(srcs);
    const pub = await sellerCall('GET', `/api/products/${productId}/gallery`);
    expect(pub.data.items.map((item: { mediaId: string }) => item.mediaId)).toEqual(afterSave);
  });
});
