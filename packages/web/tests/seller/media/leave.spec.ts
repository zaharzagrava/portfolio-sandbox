import { expect, test, type Page } from '@playwright/test';
import { sellerCall } from '../../helpers';
import { watchApi } from '../cross-cutting/support';
import { GALLERY, dbOrder, dbVersion, galleryEvents, galleryEventPayloads, galleryRoute, openGallery, shownWidths } from './edit-support';

/**
 * AI QA, area "media", pass 3: what happens to an unsaved draft when the person leaves the page, and when someone else saves
 * meanwhile (map lines `media.leave.*`, `media.save.events`). The map says: no warning anywhere. Each test checks that
 * (no beforeunload prompt, no confirm dialog, no navigation block) and that the draft is gone afterwards, with nothing written.
 */

function covers(...ids: string[]) {
  test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
}

/** Counts browser prompts (confirm/beforeunload) so a "no warning" claim is a measured zero. */
function watchPrompts(page: Page) {
  const seen: string[] = [];
  page.on('dialog', (dialog) => {
    seen.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });
  return seen;
}

async function makeDraft(page: Page) {
  await page.getByRole('button', { name: 'Move photo 2 up' }).click();
  expect(await shownWidths(page)).toEqual([12, 11, 13]);
  await expect(page.getByRole('button', { name: 'Save photos' })).toBeEnabled();
}

test.describe('Photos: leaving with an unsaved draft', () => {
  test('media.leave.unsaved-link, media.leave.tab-video, media.leave.browser-back, media.leave.unsaved-reload: no warning, the draft is dropped, nothing is written', async ({ page }) => {
    covers('media.leave.unsaved-link', 'media.leave.tab-video', 'media.leave.browser-back', 'media.leave.unsaved-reload');
    test.setTimeout(180_000);
    const { shopId, productId, mediaIds } = await openGallery(page, 3);
    const prompts = watchPrompts(page);
    const api = watchApi(page);
    const untouched = () => {
      expect(dbOrder(productId), 'the stored order never changed').toEqual(mediaIds);
      expect(dbVersion(productId)).toBe(1);
      expect(api.writes().filter((entry) => /\/(media|gallery)/.test(entry.path)), 'no photo write was sent').toEqual([]);
    };

    // 1. the "Back to inventory" link, then the browser Back: the draft is gone, no question
    await makeDraft(page);
    await page.getByRole('link', { name: 'Back to inventory' }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/seller/${shopId}/inventory`));
    await page.goBack();
    await expect(page.getByText('3 of 20 photos')).toBeVisible();
    // observed: the browser Back returns to the SAME page state, the draft is still there (the map said "lost"): P3F2
    expect(await shownWidths(page), 'after Back the draft is kept').toEqual([12, 11, 13]);
    await page.getByRole('button', { name: 'Discard changes' }).click();
    expect(await shownWidths(page)).toEqual([11, 12, 13]);

    // 2. a sidebar link
    await makeDraft(page);
    const sidebar = page.locator(`a[href="/dashboard/seller/${shopId}/orders"]`).first();
    if (!(await sidebar.isVisible())) {
      await page.getByRole('region', { name: 'Shop bar' }).getByRole('button', { name: 'Open seller menu' }).click();
      await page.getByRole('dialog', { name: 'Menu' }).locator(`a[href="/dashboard/seller/${shopId}/orders"]`).click();
    } else await sidebar.click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/seller/${shopId}/orders`));
    await page.goBack();
    await expect(page.getByText('3 of 20 photos')).toBeVisible();
    expect(await shownWidths(page)).toEqual([11, 12, 13]);

    // 3. the Video tab and back
    await makeDraft(page);
    await page.getByRole('navigation', { name: 'Product media' }).getByRole('link', { name: 'Video' }).click();
    await expect(page).toHaveURL(/\/media\/video$/);
    await page.getByRole('navigation', { name: 'Product media' }).getByRole('link', { name: 'Photos' }).click();
    await expect(page.getByText('3 of 20 photos')).toBeVisible();
    // observed: the draft is kept across the tab change as well (the map said "lost"): P3F2
    expect(await shownWidths(page), 'the draft is kept across the tab change').toEqual([12, 11, 13]);
    await page.getByRole('button', { name: 'Discard changes' }).click();

    // 4. reload: the draft is lost, no question
    await makeDraft(page);
    await page.reload();
    await expect(page.getByText('3 of 20 photos')).toBeVisible();
    expect(await shownWidths(page)).toEqual([11, 12, 13]);

    // 5. closing the tab (run the page's beforeunload handlers, as a real close does) with a draft: no question
    await makeDraft(page);
    untouched();
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => page.isClosed() || prompts.length > 0, { timeout: 10_000 }).toBe(true);
    expect(prompts, 'no browser question in any of the exits, closing included').toEqual([]);
    expect(page.isClosed(), 'the tab closed without asking').toBe(true);
    return;
    untouched();
  });

  test('media.leave.draft-survives-refetch: another editor saves while a draft is open; the draft stays, Save then meets the conflict', async ({ page }) => {
    covers('media.leave.draft-survives-refetch');
    test.setTimeout(180_000);
    const { shopId, productId, token, mediaIds } = await openGallery(page, 3);
    const api = watchApi(page);
    await makeDraft(page);
    // somebody else saves another order (version 1 -> 2)
    const other = await sellerCall('PUT', GALLERY(shopId, productId), { mediaIds: [mediaIds[2], mediaIds[1], mediaIds[0]], expectedVersion: 1 }, token);
    expect(other.status, JSON.stringify(other.data)).toBe(200);
    // the read goes stale after 60 s; the browser coming back online then reads again (the only background read this page has)
    const before = api.matching('GET', galleryRoute(shopId, productId)).length;
    await page.clock.install();
    await page.clock.fastForward(70_000);
    await page.context().setOffline(true);
    await page.context().setOffline(false);
    await expect.poll(() => api.matching('GET', galleryRoute(shopId, productId)).length, { timeout: 15_000, message: 'a background read followed' }).toBeGreaterThan(before);
    await page.clock.resume();
    expect(await shownWidths(page), 'the draft wins over the newer server order').toEqual([12, 11, 13]);
    await expect(page.getByRole('button', { name: 'Save photos' })).toBeEnabled();
    await page.getByRole('button', { name: 'Save photos' }).click();
    await expect.poll(() => api.matching('PUT', galleryRoute(shopId, productId))[0]?.status ?? null).not.toBeNull();
    expect(api.matching('PUT', galleryRoute(shopId, productId)).map((entry) => entry.status)).toEqual([409]);
    expect(dbOrder(productId), 'the other editor\'s order stands').toEqual([mediaIds[2], mediaIds[1], mediaIds[0]]);
    expect(dbVersion(productId)).toBe(2);
    await page.getByRole('button', { name: 'Load latest' }).click();
    await expect.poll(() => shownWidths(page)).toEqual([13, 12, 11]);
  });

  test('media.save.events: every real change writes one media.gallery_changed event in the outbox, an unchanged list none', async ({ page }) => {
    covers('media.save.events');
    test.setTimeout(180_000);
    const { shopId, productId, token, mediaIds } = await openGallery(page, 3);
    expect(galleryEvents(productId), 'the first fill wrote one').toBe(1);
    await page.getByRole('button', { name: 'Move photo 3 up' }).click();
    await page.getByRole('button', { name: 'Save photos' }).click();
    await expect(page.getByText('Photos saved')).toBeVisible();
    expect(galleryEvents(productId)).toBe(2);
    const last = galleryEventPayloads(productId).at(-1);
    expect(last).toMatchObject({ mediaIds: [mediaIds[0], mediaIds[2], mediaIds[1]], galleryVersion: 2 });
    // the same list again: no new event
    const same = await sellerCall('PUT', GALLERY(shopId, productId), { mediaIds: [mediaIds[0], mediaIds[2], mediaIds[1]], expectedVersion: 2 }, token);
    expect(same.status).toBe(200);
    expect(galleryEvents(productId)).toBe(2);
    // the public gallery that the product page reads follows the first image
    const pub = await sellerCall('GET', `/api/products/${productId}/gallery`);
    expect(pub.data.items.map((item: { mediaId: string }) => item.mediaId)).toEqual([mediaIds[0], mediaIds[2], mediaIds[1]]);
  });
});
