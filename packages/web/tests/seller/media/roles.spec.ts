import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { sellerCall } from '../../helpers';
import { joinShopAs, ownerWithShop, readGallery, setSuspended, tokenOf, uniqueTitle, watchApi } from '../cross-cutting/support';
import { scalar, setShopStatus } from '../support/db';
import { GALLERY, dbMediaStatus, dbOrder, dbVersion, galleryEvents, galleryRoute, mediaPath, savedGallery, shownWidths } from './edit-support';
import { photosOf, uploadReady } from './support';

/**
 * AI QA, area "media", pass 3: who may do what on the photos page and the photo routes (map lines `media.role.*`, `media.shop.*`).
 * Every built-in role is made through the real invitation flow (owner invites, the person accepts), then the page is used and the
 * answers and rows are read back.
 */

function covers(...ids: string[]) {
  test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
}
const SAVE = { name: 'Save photos' };

test.describe('Photos: roles', () => {
  test('media.role.owner, media.role.admin, media.role.staff, media.role.viewer: writers get the controls and a working save, a viewer gets a read-only page', async ({ page, browser }) => {
    covers('media.role.owner', 'media.role.admin', 'media.role.staff', 'media.role.viewer', 'media.shop.active');
    test.setTimeout(300_000);
    const { shopId, productIds, token, member } = await ownerWithShop(page, [{ title: uniqueTitle('Roles') }]);
    const productId = productIds[0];
    const mediaIds = await savedGallery(token, shopId, productId, 3);
    const roles = await sellerCall('GET', '/api/shop-roles', undefined, token);
    for (const role of ['OWNER', 'ADMIN', 'STAFF']) expect(roles.data.roles[role], `${role} may change products`).toContain('products.write');
    expect(roles.data.roles.VIEWER, 'a viewer may not').not.toContain('products.write');

    let expected = [...mediaIds];
    let version = 1;
    // each writer: the controls are there, one move is saved (PUT 200), the database and the outbox follow
    const writers: { name: 'OWNER' | 'ADMIN' | 'STAFF'; open: () => Promise<{ page: import('@playwright/test').Page; close: () => Promise<void> }> }[] = [
      { name: 'OWNER', open: async () => ({ page, close: async () => undefined }) },
      { name: 'ADMIN', open: async () => { const joined = await joinShopAs(browser, member, shopId, 'ADMIN'); return { page: joined.page, close: () => joined.context.close() }; } },
      { name: 'STAFF', open: async () => { const joined = await joinShopAs(browser, member, shopId, 'STAFF'); return { page: joined.page, close: () => joined.context.close() }; } },
    ];
    for (const writer of writers) {
      const opened = await writer.open();
      try {
        await opened.page.goto(mediaPath(shopId, productId));
        await expect(opened.page.getByText('3 of 20 photos'), writer.name).toBeVisible();
        await expect(opened.page.getByLabel('Add photos'), `${writer.name}: chooser`).toBeEnabled();
        await expect(opened.page.getByRole('button', { name: 'Remove photo 1' }), `${writer.name}: remove`).toBeEnabled();
        await expect(opened.page.getByRole('button', { name: 'Move photo 2 up' }), `${writer.name}: move`).toBeEnabled();
        await expect(opened.page.getByRole('button', SAVE), `${writer.name}: save is off until a change`).toBeDisabled();
        const api = watchApi(opened.page);
        const events = galleryEvents(productId);
        await opened.page.getByRole('button', { name: 'Move photo 2 up' }).click();
        await expect(opened.page.getByRole('button', SAVE)).toBeEnabled();
        await opened.page.getByRole('button', SAVE).click();
        await expect(opened.page.getByText('Photos saved'), writer.name).toBeVisible();
        expected = [expected[1], expected[0], expected[2]];
        version += 1;
        expect(api.matching('PUT', galleryRoute(shopId, productId)).map((entry) => entry.status), `${writer.name}: one PUT`).toEqual([200]);
        expect(dbOrder(productId), `${writer.name}: stored order`).toEqual(expected);
        expect(dbVersion(productId), `${writer.name}: version`).toBe(version);
        expect(galleryEvents(productId), `${writer.name}: one event`).toBe(events + 1);
      } finally {
        await opened.close();
      }
    }

    // the viewer: sees the photos and the counter, nothing to change; the server says the same
    const viewer = await joinShopAs(browser, member, shopId, 'VIEWER');
    try {
      const api = watchApi(viewer.page);
      await viewer.page.goto(mediaPath(shopId, productId));
      await expect(viewer.page.getByText('3 of 20 photos')).toBeVisible();
      await expect(photosOf(viewer.page)).toHaveCount(3);
      expect(await shownWidths(viewer.page)).toEqual(expected.length ? await shownWidths(viewer.page) : []);
      await expect(viewer.page.getByLabel('Add photos')).toHaveCount(0);
      await expect(viewer.page.getByRole('button', SAVE)).toHaveCount(0);
      await expect(viewer.page.getByRole('button', { name: /^Move photo/ })).toHaveCount(0);
      await expect(viewer.page.getByRole('button', { name: /^Remove photo/ })).toHaveCount(0);
      expect(api.writes(), 'a viewer page sends no write').toEqual([]);
      const viewerToken = await tokenOf(viewer.member);
      const read = await sellerCall('GET', GALLERY(shopId, productId), undefined, viewerToken);
      expect(read.status).toBe(200);
      expect(read.data.items.map((item: { mediaId: string }) => item.mediaId)).toEqual(expected);
      const put = await sellerCall('PUT', GALLERY(shopId, productId), { mediaIds: [], expectedVersion: version }, viewerToken);
      expect(put.status, JSON.stringify(put.data)).toBe(403);
      expect(put.data.type).toMatch(/permission_denied$/);
      const start = await sellerCall('POST', `/api/shops/${shopId}/media/uploads`, { purpose: 'product' }, viewerToken);
      expect(start.status, JSON.stringify(start.data)).toBe(403);
      expect(scalar(`select count(*) from "Media" where "shopId"='${shopId}' and status='PENDING_UPLOAD'`), 'no slot for a viewer').toBe('0');
      expect(dbOrder(productId)).toEqual(expected);
      expect(dbVersion(productId)).toBe(version);
    } finally {
      await viewer.context.close();
    }
  });

  test('media.role.non-member, media.role.anonymous-api, media.role.no-products-read: a stranger and a signed-out caller reach nothing', async ({ page, browser }) => {
    covers('media.role.non-member', 'media.role.anonymous-api');
    test.setTimeout(180_000);
    const { shopId, productIds, token } = await ownerWithShop(page, [{ title: uniqueTitle('Strangers') }]);
    const productId = productIds[0];
    const [mediaId] = await savedGallery(token, shopId, productId, 1);
    const unfinished = (await sellerCall('POST', `/api/shops/${shopId}/media/uploads`, { purpose: 'product' }, token)).data.mediaId as string;
    const strangerPage = await (await browser.newContext()).newPage();
    const stranger = await ownerWithShop(strangerPage, []);
    try {
      // the page of a shop the person does not belong to: not found, nothing of the shop in any answer
      const answers: string[] = [];
      strangerPage.on('response', (response) => {
        if (new URL(response.url()).pathname.startsWith('/api/')) void response.text().then((text) => answers.push(text)).catch(() => undefined);
      });
      await strangerPage.goto(mediaPath(shopId, productId));
      await expect(strangerPage.getByText(/couldn't find that shop/i)).toBeVisible();
      await expect(strangerPage.getByLabel('Add photos')).toHaveCount(0);
      expect(answers.join('\n'), 'no photo of the foreign shop reaches the browser').not.toContain(mediaId);

      // the routes: 404 as for something that does not exist, nothing changed
      const unknownShop = await sellerCall('GET', GALLERY(randomUUID(), productId), undefined, stranger.token);
      const read = await sellerCall('GET', GALLERY(shopId, productId), undefined, stranger.token);
      expect(read.status).toBe(404);
      expect(read.data.type, 'same problem as an unknown shop').toBe(unknownShop.data.type);
      expect((await sellerCall('PUT', GALLERY(shopId, productId), { mediaIds: [], expectedVersion: 1 }, stranger.token)).status).toBe(404);
      expect((await sellerCall('POST', `/api/shops/${shopId}/media/uploads`, { purpose: 'product' }, stranger.token)).status).toBe(404);
      expect(dbOrder(productId)).toEqual([mediaId]);
      expect(dbVersion(productId)).toBe(1);

      // signed out: 401 on every write and on the owner read; a READY photo is public
      expect((await sellerCall('POST', `/api/shops/${shopId}/media/uploads`, { purpose: 'product' })).status).toBe(401);
      expect((await sellerCall('POST', `/api/media/${unfinished}/complete`)).status).toBe(401);
      expect((await sellerCall('PUT', GALLERY(shopId, productId), { mediaIds: [], expectedVersion: 1 })).status).toBe(401);
      expect((await sellerCall('DELETE', `/api/media/${mediaId}`)).status).toBe(401);
      expect((await sellerCall('GET', GALLERY(shopId, productId))).status).toBe(401);
      const publicRead = await sellerCall('GET', `/api/media/${mediaId}`);
      expect(publicRead.status).toBe(200);
      expect(publicRead.data.status).toBe('READY');
      expect(dbMediaStatus(mediaId)).toBe('READY');
      expect(dbMediaStatus(unfinished)).toBe('PENDING_UPLOAD');
    } finally {
      await strangerPage.close();
    }
  });

  test('media.role.other-user-complete, media.role.complete-after-role-loss: another user, or an uploader who lost the right, cannot finish or delete a photo', async ({ page, browser }) => {
    covers('media.role.other-user-complete', 'media.role.complete-after-role-loss');
    test.setTimeout(240_000);
    const { shopId, token, member } = await ownerWithShop(page, []);
    const mine = (await sellerCall('POST', `/api/shops/${shopId}/media/uploads`, { purpose: 'product' }, token)).data;
    const ready = await uploadReady(token, shopId);
    const stranger = await ownerWithShop(await (await browser.newContext()).newPage(), []);
    const unknown = await sellerCall('POST', `/api/media/${randomUUID()}/complete`, undefined, stranger.token);
    const foreign = await sellerCall('POST', `/api/media/${mine.mediaId}/complete`, undefined, stranger.token);
    expect(foreign.status).toBe(404);
    expect(foreign.data.type, 'same problem as an unknown id').toBe(unknown.data.type);
    const foreignDelete = await sellerCall('DELETE', `/api/media/${ready}`, undefined, stranger.token);
    expect(foreignDelete.status).toBe(404);
    expect(dbMediaStatus(mine.mediaId)).toBe('PENDING_UPLOAD');
    expect(dbMediaStatus(ready)).toBe('READY');

    // a STAFF member starts an upload, then loses products.write (becomes VIEWER), then tries to finish it
    const staff = await joinShopAs(browser, member, shopId, 'STAFF');
    try {
      const staffToken = await tokenOf(staff.member);
      const started = (await sellerCall('POST', `/api/shops/${shopId}/media/uploads`, { purpose: 'product' }, staffToken)).data;
      const form = new FormData();
      for (const [name, value] of Object.entries(started.upload.fields as Record<string, string>)) form.append(name, value);
      form.append('Content-Type', 'image/png');
      form.append('file', new Blob([new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))], { type: 'image/png' }), 'photo');
      expect((await fetch(started.upload.url, { method: 'POST', body: form })).status).toBe(204);
      const userId = scalar(`select id from "User" where email='${staff.member.email}'`);
      const changed = await sellerCall('PATCH', `/api/shops/${shopId}/members/${userId}`, { role: 'VIEWER' }, token);
      expect(changed.status, JSON.stringify(changed.data)).toBeLessThan(300);
      const complete = await sellerCall('POST', `/api/media/${started.mediaId}/complete`, undefined, staffToken);
      expect([403, 404], `complete after losing the right: ${JSON.stringify(complete.data)}`).toContain(complete.status);
      expect(dbMediaStatus(started.mediaId), 'the photo is not processed').toBe('PENDING_UPLOAD');
    } finally {
      await staff.context.close();
    }
  });

  test('media.shop.suspended, media.shop.deleting: a closed shop keeps its photos readable and turns every write off', async ({ page }) => {
    covers('media.shop.suspended', 'media.shop.deleting');
    test.setTimeout(180_000);
    const { shopId, productIds, token } = await ownerWithShop(page, [{ title: uniqueTitle('Closed') }]);
    const productId = productIds[0];
    const mediaIds = await savedGallery(token, shopId, productId, 2);
    for (const state of ['SUSPENDED', 'DELETING'] as const) {
      if (state === 'SUSPENDED') await setSuspended(shopId, true);
      else {
        setShopStatus(shopId, 'DELETING');
      }
      try {
        const api = watchApi(page);
        await page.goto(mediaPath(shopId, productId));
        // the sentence of the state is on the page and no write control is on
        const sentence = state === 'SUSPENDED' ? /suspended/i : /(deleted|closed|closing|being)/i;
        await expect(page.getByText(sentence).first(), state).toBeVisible();
        await expect(page.getByLabel('Add photos'), `${state}: chooser`).toHaveCount(0);
        await expect(page.getByRole('button', SAVE), `${state}: save`).toHaveCount(0);
        await expect(page.getByRole('button', { name: /^(Move|Remove) photo/ }), `${state}: move and remove`).toHaveCount(0);
        // the photos stay readable (map: "photos visible"); soft: the 2 cards and the counter
        const gallery = api.matching('GET', galleryRoute(shopId, productId)).map((entry) => entry.status);
        expect.soft(gallery, `${state}: the photos are still read`).toEqual([200]);
        await expect.soft(page.getByText('2 of 20 photos'), `${state}: the photos are shown`).toBeVisible();
        const put = await sellerCall('PUT', GALLERY(shopId, productId), { mediaIds: [mediaIds[0]], expectedVersion: 1 }, token);
        expect(put.status, `${state}: ${JSON.stringify(put.data)}`).toBe(state === 'SUSPENDED' ? 403 : 409);
        expect(put.data.type).toMatch(state === 'SUSPENDED' ? /shop_suspended$/ : /shop_offboarding$/);
        expect(dbOrder(productId)).toEqual(mediaIds);
        expect(dbVersion(productId)).toBe(1);
      } finally {
        if (state === 'SUSPENDED') await setSuspended(shopId, false);
      }
    }
    setShopStatus(shopId, 'ACTIVE');
    expect((await readGallery(token, shopId, productId)).version).toBe(1);
  });
});
