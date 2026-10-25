import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { sellerCall } from '../../helpers';
import { ownerWithShop, uniqueTitle } from '../cross-cutting/support';
import { scalar } from '../support/db';
import { GALLERY, dbOrder, dbVersion, galleryEvents, makePhotos, mediaPath, savedGallery, shownWidths, widthOf } from './edit-support';
import { greyPng, photo, photosOf, pixel } from './support';

/**
 * AI QA, area "media", pass 3: the screen's side of lines that were first checked on the API and the database only (map lines
 * `media.save.*`, `media.order.same-list`, `media.remove.*`, `media.proc.*`, `media.upload.step*`, `media.upload.error.csrf`).
 * After the API call, the person opens the photos page and must see exactly what the database says.
 */
function covers(...ids: string[]) {
  test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sharp: any = createRequire(path.join(__dirname, '../../../../backend/package.json'))('sharp');

test.describe('Photos page shows what the API and database settled', () => {
  test('media.save.20-limit, media.save.api-validation, media.order.same-list, media.save.idempotency, media.save.conflict-race: a full gallery, refused and repeated writes, a race', async ({ page }) => {
    covers('media.save.20-limit', 'media.save.api-validation', 'media.order.same-list', 'media.save.idempotency', 'media.save.conflict-race');
    test.setTimeout(300_000);
    const { shopId, productIds, token } = await ownerWithShop(page, [{ title: uniqueTitle('Closure Full') }]);
    const productId = productIds[0];
    const ids = await makePhotos(token, shopId, 21);
    const put = (mediaIds: string[], expectedVersion: number) => sellerCall('PUT', GALLERY(shopId, productId), { mediaIds, expectedVersion }, token);
    expect((await put(ids.slice(0, 20), 0)).status).toBe(200);
    expect((await put(ids, 1)).status, '21 ids').toBe(400);
    expect((await put([ids[0], ids[0]], 1)).status, 'duplicate').toBe(400);
    expect(dbVersion(productId)).toBe(1);
    await page.goto(mediaPath(shopId, productId));
    await expect(page.getByText('20 of 20 photos')).toBeVisible();
    await expect(page.getByText('The gallery holds up to 20 photos.')).toBeVisible();
    await expect(page.getByLabel('Add photos'), 'full gallery: no more photos can be chosen').toBeDisabled();
    await expect(photosOf(page)).toHaveCount(20);
    expect(await shownWidths(page)).toEqual(Array.from({ length: 20 }, (_, index) => widthOf(index)));
    // same list again and a replay: nothing changes, the page shows the same, Save is off
    const events = galleryEvents(productId);
    expect((await put(ids.slice(0, 20), 1)).status, 'same list').toBe(200);
    expect((await put(ids.slice(0, 20), 1)).status, 'replay').toBe(200);
    expect(dbVersion(productId)).toBe(1);
    expect(galleryEvents(productId)).toBe(events);
    await page.reload();
    await expect(photosOf(page)).toHaveCount(20);
    expect(await shownWidths(page)).toEqual(Array.from({ length: 20 }, (_, index) => widthOf(index)));
    await expect(page.getByRole('button', { name: 'Save photos' })).toBeDisabled();
    // a race: two different orders at the same version, one wins, one gets 409; the page shows the winner
    const first = [ids[1], ...ids.slice(0, 1), ...ids.slice(2, 20)];
    const second = [ids[2], ...ids.slice(0, 2), ...ids.slice(3, 20)];
    const answers = await Promise.all([put(first, 1), put(second, 1)]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    await page.reload();
    await expect(photosOf(page)).toHaveCount(20);
    const winner = dbOrder(productId);
    expect([first, second]).toContainEqual(winner);
    expect(dbVersion(productId)).toBe(2);
    expect(await shownWidths(page)).toEqual(winner.map((id) => widthOf(ids.indexOf(id))));
  });

  test('media.remove.api-delete, media.remove.orphans: photos that are not in the gallery are invisible on the page; one that is stays even when deletion is asked', async ({ page }) => {
    covers('media.remove.api-delete', 'media.remove.orphans');
    test.setTimeout(240_000);
    const { shopId, productIds, token } = await ownerWithShop(page, [{ title: uniqueTitle('Closure Orphans') }]);
    const productId = productIds[0];
    const [attached] = await savedGallery(token, shopId, productId, 1);
    const [loose] = await makePhotos(token, shopId, 1, 5);
    await page.goto(mediaPath(shopId, productId));
    await expect(page.getByText('1 of 20 photos'), 'a photo that was never attached is not shown').toBeVisible();
    expect(await shownWidths(page)).toEqual([11]);
    expect((await sellerCall('DELETE', `/api/media/${attached}`, undefined, token)).status, 'in a gallery').toBe(409);
    expect((await sellerCall('DELETE', `/api/media/${loose}`, undefined, token)).status).toBe(204);
    await page.reload();
    await expect(page.getByText('1 of 20 photos')).toBeVisible();
    expect(await shownWidths(page), 'the attached photo is still shown').toEqual([11]);
    expect(scalar(`select status from "Media" where id='${attached}'`)).toBe('READY');
    expect(scalar(`select status from "Media" where id='${loose}'`)).toBe('DELETED');
  });

  test('media.proc.variants, media.proc.worker-idempotent: a turned phone photo shows upright; a queue message delivered again shows no second card', async ({ page }) => {
    covers('media.proc.variants', 'media.proc.worker-idempotent');
    test.setTimeout(180_000);
    const { shopId, productIds, token } = await ownerWithShop(page, [{ title: uniqueTitle('Closure Upright') }]);
    const productId = productIds[0];
    // 300 wide x 200 high file marked "turn 90 degrees": upright it is 200 wide x 300 high
    const jpeg = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#c33' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    await page.goto(mediaPath(shopId, productId));
    await page.getByLabel('Add photos').setInputFiles(photo('phone.jpg', jpeg, 'image/jpeg'));
    await expect(photosOf(page)).toHaveCount(1, { timeout: 60_000 });
    const card = photosOf(page).first();
    expect(Number(await card.getAttribute('width')), 'width after the turn').toBe(200);
    expect(Number(await card.getAttribute('height')), 'height after the turn').toBe(300);
    expect(new URL((await card.getAttribute('src')) ?? '').pathname).toMatch(/\/media\/derived\/[0-9a-f]{64}\.webp$/);
    const mediaId = scalar(`select id from "Media" where "shopId"='${shopId}'`);
    const key = scalar(`select "originalKey" from "Media" where id='${mediaId}'`);
    for (let copy = 0; copy < 2; copy++) {
      const sent = await fetch('http://localhost:9324/000000000000/media-processing', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ Action: 'SendMessage', MessageBody: JSON.stringify({ mediaId, originalKey: key }) }),
      });
      expect(sent.status).toBe(200);
    }
    await page.getByRole('button', { name: 'Save photos' }).click();
    await expect(page.getByText('Photos saved')).toBeVisible();
    await expect.poll(() => scalar(`select count(*) from "Outbox" where type='media.ready' and "aggregateId"='${mediaId}'`), { timeout: 20_000 }).toBe('1');
    await page.reload();
    await expect(page.getByText('1 of 20 photos')).toBeVisible();
    await expect(photosOf(page)).toHaveCount(1);
  });

  test('media.upload.step1.permission, media.upload.step3.complete, media.upload.error.csrf: the page sends the permission and complete calls with the proof header, the storage post without cookies', async ({ page }) => {
    covers('media.upload.step1.permission', 'media.upload.step3.complete', 'media.upload.error.csrf');
    test.setTimeout(120_000);
    const { shopId, productIds } = await ownerWithShop(page, [{ title: uniqueTitle('Closure Csrf') }]);
    const seen: { kind: string; headers: Record<string, string>; status?: number }[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      const kind = /\/media\/uploads$/.test(url.pathname) ? 'start' : /\/media\/[0-9a-f-]{36}\/complete$/.test(url.pathname) ? 'complete' : url.port === '9100' && request.method() === 'POST' ? 'storage' : '';
      if (kind) seen.push({ kind, headers: request.headers() });
    });
    page.on('response', (response) => {
      const url = new URL(response.url());
      const entry = seen.find((item) => item.status === undefined && ((item.kind === 'start' && /\/media\/uploads$/.test(url.pathname)) || (item.kind === 'complete' && /\/complete$/.test(url.pathname)) || (item.kind === 'storage' && url.port === '9100')));
      if (entry) entry.status = response.status();
    });
    await page.goto(mediaPath(shopId, productIds[0]));
    await page.getByLabel('Add photos').setInputFiles(pixel('proof.png'));
    await expect(photosOf(page)).toHaveCount(1, { timeout: 60_000 });
    expect(seen.map((item) => item.kind)).toEqual(['start', 'storage', 'complete']);
    expect(seen[0].status).toBe(201);
    expect([200, 202]).toContain(seen[2].status);
    for (const item of seen.filter((entry) => entry.kind !== 'storage')) expect(item.headers['x-csrf-token'], `${item.kind} carries the proof`).toBeTruthy();
    const storage = seen[1];
    expect(storage.headers['x-csrf-token'], 'storage: no proof').toBeUndefined();
    expect(storage.headers.cookie, 'storage: no cookie').toBeUndefined();
    expect(storage.headers.authorization, 'storage: no authorization').toBeUndefined();
    const row = scalar(`select purpose||'|'||"shopId" from "Media" where "shopId"='${shopId}'`);
    expect(row).toBe(`product|${shopId}`);
  });
});
void greyPng;
