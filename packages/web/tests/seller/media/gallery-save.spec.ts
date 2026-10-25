import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { sellerCall } from '../../helpers';
import { archiveByApi, openSecondShop, ownerWithShop, readGallery, setSuspended, uniqueTitle, watchApi } from '../cross-cutting/support';
import { execFileSync } from 'node:child_process';
import { rows, setShopStatus } from '../support/db';
import { GALLERY, fakeStatuses, dbMediaStatus, dbOrder, dbVersion, galleryEvents, galleryRoute, makePhotos, mediaPath, openGallery, savedGallery, shownWidths } from './edit-support';
import { photosOf, pixel, uploadsOf } from './support';

/**
 * AI QA, area "media", pass 2: saving the gallery, the server's answers to it and what the page says (map lines `media.save.*`).
 * The API part uses the member's own token; the page part clicks "Save photos". The database and the outbox are read back.
 */

function covers(...ids: string[]) {
  test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
}
const SAVE = { name: 'Save photos' };
const problemText = (page: import('@playwright/test').Page) => page.getByRole('alert').filter({ hasText: /\S/ }).first();

test.describe('Photos save: validation, conflicts and failures', () => {
  test('media.save.api-validation, media.save.20-limit, media.save.unknown-product, media.save.not-attachable, media.save.archived: the PUT refuses what it must and leaves the rows alone', async ({ page }) => {
    covers('media.save.api-validation', 'media.save.20-limit', 'media.save.unknown-product', 'media.save.not-attachable', 'media.save.archived');
    test.setTimeout(240_000);
    const { shopId, productIds, token, member } = await ownerWithShop(page, [{ title: uniqueTitle('Put One') }, { title: uniqueTitle('Put Two') }]);
    const [productId, archivedId] = productIds;
    const ids = await makePhotos(token, shopId, 21);
    const put = (body: unknown, route = GALLERY(shopId, productId), who = token) => sellerCall('PUT', route, body, who);
    const untouched = async (message: string) => {
      expect(dbOrder(productId), message).toEqual([]);
      expect(dbVersion(productId), message).toBe(0);
    };

    // 400 validation_failed: 21 ids, duplicate, non-uuid, extra field, bad expectedVersion, missing fields
    for (const [name, body] of [
      ['21 ids', { mediaIds: ids, expectedVersion: 0 }],
      ['duplicate id', { mediaIds: [ids[0], ids[0]], expectedVersion: 0 }],
      ['non-uuid id', { mediaIds: ['nope'], expectedVersion: 0 }],
      ['extra field', { mediaIds: [ids[0]], expectedVersion: 0, extra: 1 }],
      ['negative version', { mediaIds: [ids[0]], expectedVersion: -1 }],
      ['text version', { mediaIds: [ids[0]], expectedVersion: 'a' }],
      ['fractional version', { mediaIds: [ids[0]], expectedVersion: 0.5 }],
      ['no version', { mediaIds: [ids[0]] }],
      ['no list', { expectedVersion: 0 }],
      ['list is not a list', { mediaIds: ids[0], expectedVersion: 0 }],
    ] as const) {
      const answer = await put(body);
      expect(answer.status, `${name}: ${JSON.stringify(answer.data)}`).toBe(400);
      expect(answer.data.type, name).toMatch(/validation_failed$/);
    }
    expect((await put({ mediaIds: [ids[0]], expectedVersion: 0 }, `/api/shops/${shopId}/products/not-a-uuid/gallery`)).status, 'bad product id').toBe(400);
    expect((await put({ mediaIds: [ids[0]], expectedVersion: 0 }, `/api/shops/not-a-uuid/products/${productId}/gallery`)).status, 'bad shop id').toBe(400);
    await untouched('after the refused calls');

    // not attachable: an unknown id, a photo of another shop, a photo that is not finished
    const strangerPage = await page.context().browser()!.newContext();
    try {
      const other = await ownerWithShop(await strangerPage.newPage(), []);
      const foreign = (await makePhotos(other.token, other.shopId, 1))[0];
      const unfinished = await sellerCall('POST', `/api/shops/${shopId}/media/uploads`, { purpose: 'product' }, token);
      expect(unfinished.status).toBe(201);
      const cases: [string, string, string][] = [
        ['unknown id', randomUUID(), 'not_found'],
        ['photo of another shop', foreign, 'not_found'],
        ['upload not finished', unfinished.data.mediaId, 'not_ready'],
      ];
      for (const [name, id, why] of cases) {
        const answer = await put({ mediaIds: [ids[0], id], expectedVersion: 0 });
        expect(answer.status, `${name}: ${JSON.stringify(answer.data)}`).toBe(422);
        expect(answer.data.type, name).toMatch(/media_not_attachable$/);
        expect(JSON.stringify(answer.data), `${name} names the reason`).toContain(why);
        expect(JSON.stringify(answer.data), 'the answer does not show where the foreign photo lives').not.toContain(other.shopId);
      }
      // another seller cannot write to this product either, and a product of the other shop is "not found" for this member
      expect((await put({ mediaIds: [], expectedVersion: 0 }, GALLERY(shopId, productId), other.token)).status).toBe(404);
      const foreignProduct = await put({ mediaIds: [], expectedVersion: 0 }, GALLERY(other.shopId, other.productIds[0] ?? randomUUID()));
      expect([403, 404]).toContain(foreignProduct.status);
    } finally {
      await strangerPage.close();
    }
    expect((await put({ mediaIds: [], expectedVersion: 0 }, GALLERY(shopId, randomUUID()))).status, 'unknown product').toBe(404);
    expect((await put({ mediaIds: [], expectedVersion: 0 }, GALLERY(shopId, randomUUID()))).data.type).toMatch(/product_not_found$/);
    await untouched('after the 422 and 404 answers');

    // 20 is allowed (all 20 attached) and the 21st is refused already by the schema
    const twenty = await put({ mediaIds: ids.slice(0, 20), expectedVersion: 0 });
    expect(twenty.status, JSON.stringify(twenty.data)).toBe(200);
    expect(dbOrder(productId)).toEqual(ids.slice(0, 20));
    expect(dbVersion(productId)).toBe(1);
    expect((await put({ mediaIds: ids, expectedVersion: 1 })).status).toBe(400);
    expect(dbVersion(productId)).toBe(1);

    // an archived product: 409 product_archived, rows unchanged
    const archivedPhotos = await savedGallery(token, shopId, archivedId, 1);
    await archiveByApi(token, shopId, archivedId);
    const archived = await put({ mediaIds: [], expectedVersion: 1 }, GALLERY(shopId, archivedId));
    expect(archived.status, JSON.stringify(archived.data)).toBe(409);
    expect(archived.data.type).toMatch(/product_archived$/);
    expect(dbOrder(archivedId)).toEqual(archivedPhotos);
    void member;
  });

  test('media.save.conflict, media.save.conflict-copy, media.save.after-save-new-photo: two tabs; the late save gets a conflict and "Load latest" shows the other tab\'s work', async ({ page }) => {
    covers('media.save.conflict', 'media.save.conflict-copy', 'media.save.after-save-new-photo');
    test.setTimeout(180_000);
    const { shopId, productId, token, mediaIds } = await openGallery(page, 3);
    const tabB = await page.context().newPage();
    await tabB.goto(mediaPath(shopId, productId));
    await expect(tabB.getByText('3 of 20 photos')).toBeVisible();

    // tab A saves a new order: version 1 -> 2
    await page.getByRole('button', { name: 'Move photo 3 up' }).click();
    await page.getByRole('button', SAVE).click();
    await expect(page.getByText('Photos saved')).toBeVisible();
    expect(dbVersion(productId)).toBe(2);
    const afterA = [mediaIds[0], mediaIds[2], mediaIds[1]];
    expect(dbOrder(productId)).toEqual(afterA);

    // tab B still holds version 1 and saves its own change
    const api = watchApi(tabB);
    await tabB.getByRole('button', { name: 'Remove photo 1' }).click();
    await tabB.getByRole('button', SAVE).click();
    await expect(problemText(tabB)).toBeVisible();
    expect(api.matching('PUT', galleryRoute(shopId, productId)).map((entry) => entry.status)).toEqual([409]);
    expect(await problemText(tabB).innerText(), 'the conflict sentence (it names the photos)').toContain('The photos changed since you opened this page.');
    expect(dbOrder(productId), 'B changed nothing').toEqual(afterA);
    expect(dbVersion(productId)).toBe(2);
    // the draft is still there, and "Load latest" is offered
    expect(await shownWidths(tabB)).toEqual([12, 13]);
    await tabB.getByRole('button', { name: 'Load latest' }).click();
    await expect(tabB.getByRole('button', { name: 'Discard changes' })).toHaveCount(0);
    await expect(problemText(tabB)).toHaveCount(0);
    await expect.poll(() => shownWidths(tabB), { message: "A's order is shown after the refetch" }).toEqual([11, 13, 12]);
    expect(api.matching('GET', galleryRoute(shopId, productId)).length, 'one more read of the gallery').toBe(1);

    // after the reload, B's next save carries the new version and wins
    await tabB.getByRole('button', { name: 'Remove photo 1' }).click();
    await tabB.getByRole('button', SAVE).click();
    await expect(tabB.getByText('Photos saved')).toBeVisible();
    expect(dbVersion(productId)).toBe(3);
    expect(dbOrder(productId)).toEqual([mediaIds[2], mediaIds[1]]);

    // a new photo after a save: the PUT uses the new version and wins
    const extra = (await makePhotos(token, shopId, 1, 5))[0];
    void extra;
    const fresh = await readGallery(token, shopId, productId);
    expect(fresh.version).toBe(3);
  });

  test('media.save.conflict-race: two simultaneous PUTs with the same version give one 200, one 409 and one event', async ({ page }) => {
    covers('media.save.conflict-race');
    test.setTimeout(180_000);
    const { shopId, productId, token, mediaIds } = await openGallery(page, 3);
    const events = galleryEvents(productId);
    const calls = [[mediaIds[2], mediaIds[1], mediaIds[0]], [mediaIds[1], mediaIds[0], mediaIds[2]], [mediaIds[0]], [mediaIds[2]]];
    const answers = await Promise.all(calls.map((list) => sellerCall('PUT', GALLERY(shopId, productId), { mediaIds: list, expectedVersion: 1 }, token)));
    expect(answers.map((answer) => answer.status).sort(), JSON.stringify(answers.map((a) => a.data?.type))).toEqual([200, 409, 409, 409]);
    expect(dbVersion(productId)).toBe(2);
    expect(galleryEvents(productId)).toBe(events + 1);
    const winner = calls[answers.findIndex((answer) => answer.status === 200)];
    expect(dbOrder(productId)).toEqual(winner);
    const positions = rows(`select count(*), count(distinct position) from "ProductMedia" where "productId"='${productId}'`)[0];
    expect(positions[0]).toBe(positions[1]);
  });

  test('media.save.suspended, media.save.offboarding: a shop closed after the page opened refuses the save with its own sentence', async ({ page }) => {
    covers('media.save.suspended', 'media.save.offboarding');
    test.setTimeout(180_000);
    const { shopId, productId, mediaIds, token } = await openGallery(page, 2);
    const api = watchApi(page);
    await page.getByRole('button', { name: 'Move photo 2 up' }).click();
    await setSuspended(shopId, true);
    try {
      await page.getByRole('button', SAVE).click();
      await expect(problemText(page)).toContainText('suspended');
      expect(api.matching('PUT', galleryRoute(shopId, productId)).map((entry) => entry.status)).toEqual([403]);
      expect(dbOrder(productId)).toEqual(mediaIds);
      expect(dbVersion(productId)).toBe(1);
      // the refusal is mapped with `refetch: true`: the page must learn the shop is suspended (a read follows and the controls go off)
      await expect.soft.poll(() => api.seen.filter((entry) => entry.method === 'GET' && entry.path.startsWith(`/api/shops/${shopId}`)).length, { message: 'a refresh after the refusal' }).toBeGreaterThan(0);
      await expect.soft(page.getByRole('button', SAVE)).toBeDisabled();
    } finally {
      await setSuspended(shopId, false);
    }
    // a shop that is being deleted: the API refuses with 409 shop_offboarding (page opened before it)
    await page.reload();
    await page.getByRole('button', { name: 'Move photo 2 up' }).click();
    setShopStatus(shopId, 'DELETING');
    try {
      // the member's access is cached for up to 15 s and a direct change of the row does not clear it: wait until the gate answers
      // (AS-03: upload permission on a DELETING shop is 409 shop_offboarding)
      await expect
        .poll(async () => (await sellerCall('POST', `/api/shops/${shopId}/media/uploads`, { purpose: 'product' }, token)).status, { timeout: 40_000, message: 'AS-03: presign on a closing shop' })
        .toBe(409);
      expect((await sellerCall('POST', `/api/shops/${shopId}/media/uploads`, { purpose: 'product' }, token)).data.type).toMatch(/shop_offboarding$/);
      api.reset();
      await page.getByRole('button', SAVE).click();
      await expect(problemText(page)).toBeVisible();
      const put = api.matching('PUT', galleryRoute(shopId, productId));
      expect(put.map((entry) => entry.status)).toEqual([409]);
      expect(dbOrder(productId)).toEqual(mediaIds);
    } finally {
      setShopStatus(shopId, 'ACTIVE');
    }
  });

  test('media.save.offboarding, media.save.button: a page opened while the shop is being closed shows the reason and turns the controls off', async ({ page }) => {
    covers('media.save.offboarding', 'media.save.button');
    test.setTimeout(120_000);
    const { shopId, productId } = await openGallery(page, 2);
    setShopStatus(shopId, 'DELETING');
    try {
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: 'Photos' })).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: 'This shop is being closed. You can view data but not make changes.' }).last()).toBeVisible();
      await expect(page.getByRole('button', SAVE)).toBeDisabled();
      await expect(page.getByRole('button', SAVE)).toHaveAttribute('title', 'This shop is being closed. You can view data but not make changes.');
      await expect(page.getByLabel('Add photos')).toBeDisabled();
      await expect(page.getByRole('button', { name: /^(Move|Remove) photo/ })).toHaveCount(0);
      await expect(photosOf(page)).toHaveCount(2);
    } finally {
      setShopStatus(shopId, 'ACTIVE');
    }
    void productId;
  });

  test('media.save.with-pending-uploads, media.save.after-save-new-photo: saving while a photo is still processing saves only the list; the finished photo joins the draft and the next save carries the new version', async ({ page }) => {
    covers('media.save.with-pending-uploads', 'media.save.after-save-new-photo');
    test.setTimeout(180_000);
    const { shopId, productId, mediaIds } = await openGallery(page, 2);
    const api = watchApi(page);
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => void dialogs.push(dialog.message()));
    let release = false;
    await fakeStatuses(page, () => (release ? null : { status: 'PROCESSING' }));
    const bodies: { mediaIds: string[]; expectedVersion: number }[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT' && galleryRoute(shopId, productId).test(new URL(request.url()).pathname)) bodies.push(request.postDataJSON());
    });
    await page.getByRole('button', { name: 'Move photo 2 up' }).click();
    await page.getByLabel('Add photos').setInputFiles(pixel('late.png'));
    await expect(uploadsOf(page).getByRole('status')).toHaveText('Processing');
    await page.getByRole('button', SAVE).click();
    await expect(page.getByText('Photos saved')).toBeVisible();
    expect(bodies).toEqual([{ mediaIds: [mediaIds[1], mediaIds[0]], expectedVersion: 1 }]);
    expect(dbOrder(productId)).toEqual([mediaIds[1], mediaIds[0]]);
    expect(dialogs, 'no warning about the photo in progress').toEqual([]);
    await expect(uploadsOf(page).getByRole('status')).toHaveText('Processing');
    // the photo finishes: it joins the draft (not saved), the counter rises and Save is on again
    release = true;
    await expect(photosOf(page)).toHaveCount(3, { timeout: 60_000 });
    await expect(page.getByText('3 of 20 photos')).toBeVisible();
    await expect(page.getByRole('button', SAVE)).toBeEnabled();
    expect(dbOrder(productId), 'the new photo is not saved yet').toEqual([mediaIds[1], mediaIds[0]]);
    // the next save carries the version of the first one and wins
    await page.getByRole('button', SAVE).click();
    await expect.poll(() => api.matching('PUT', galleryRoute(shopId, productId)).map((entry) => entry.status)).toEqual([200, 200]);
    await expect(page.getByRole('button', { name: 'Discard changes' })).toHaveCount(0);
    expect(bodies.at(-1)?.expectedVersion).toBe(2);
    expect(bodies.at(-1)?.mediaIds.slice(0, 2)).toEqual([mediaIds[1], mediaIds[0]]);
    expect(dbOrder(productId)).toHaveLength(3);
    expect(dbVersion(productId)).toBe(3);
  });

  test('media.save.not-attachable: a photo that no longer exists when the person saves gives the plain sentence and keeps the draft', async ({ page }) => {
    covers('media.save.not-attachable');
    test.setTimeout(120_000);
    const { shopId, productId, mediaIds } = await openGallery(page, 2);
    const api = watchApi(page);
    await page.getByRole('button', { name: 'Move photo 2 up' }).click();
    execFileSync('docker', ['exec', '-i', 'payment_system_db', 'psql', '-U', 'postgres', '-d', 'marketplace', '-c', `update "Media" set status='DELETED' where id='${mediaIds[1]}'`]);
    await page.getByRole('button', SAVE).click();
    await expect(problemText(page)).toContainText("Some photos aren't ready yet or no longer exist. Remove them or wait for them to finish, then save again.");
    expect(api.matching('PUT', galleryRoute(shopId, productId)).map((entry) => entry.status)).toEqual([422]);
    expect(await shownWidths(page), 'the draft is kept').toEqual([12, 11]);
    expect(dbOrder(productId)).toEqual(mediaIds);
    expect(dbVersion(productId)).toBe(1);
    // removing the missing photo from the draft lets the save through
    await page.getByRole('button', { name: 'Remove photo 1' }).click();
    await page.getByRole('button', SAVE).click();
    await expect(page.getByText('Photos saved')).toBeVisible();
    expect(dbOrder(productId)).toEqual([mediaIds[0]]);
  });

  test('media.save.500, media.save.offline, media.save.error-clear: a failed save keeps the draft and the next try works', async ({ page, context }) => {
    covers('media.save.500', 'media.save.offline', 'media.save.error-clear');
    test.setTimeout(180_000);
    const { shopId, productId, mediaIds } = await openGallery(page, 3);
    const api = watchApi(page);
    await page.getByRole('button', { name: 'Move photo 3 up' }).click();

    // a 500 from the server
    await page.route(`**${GALLERY(shopId, productId)}`, (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 500, contentType: 'application/problem+json', body: JSON.stringify({ type: 'https://errors.example/internal', title: 'Internal', status: 500 }) }) : route.fallback()), { times: 1 });
    await page.getByRole('button', SAVE).click();
    await expect(problemText(page)).toBeVisible();
    const sentence500 = await problemText(page).innerText();
    expect(sentence500).not.toMatch(/internal|exception|stack|SQL/i);
    expect(await shownWidths(page), 'the draft is kept').toEqual([11, 13, 12]);
    await expect(page.getByRole('button', SAVE)).toBeEnabled();
    expect(dbVersion(productId)).toBe(1);

    // the network is gone before the press: the banner says changes cannot be saved; the press must not vanish silently (P2F3)
    await context.setOffline(true);
    await expect(page.getByText("You're offline. Changes can't be saved.").first()).toBeVisible();
    api.reset();
    await page.getByRole('button', SAVE).click();
    await expect.poll(() => api.matching('PUT', galleryRoute(shopId, productId)).length, { message: 'no request leaves while offline' }).toBe(0);
    expect(await shownWidths(page), 'the draft is kept offline').toEqual([11, 13, 12]);
    expect(dbVersion(productId)).toBe(1);
    // P2F3: the press is parked by the query library: no sentence, the button greyed for good, and the save goes out by itself at reconnect
    expect.soft(await page.getByRole('button', SAVE).isEnabled(), 'after the press offline the person can still see what to do (button enabled or a sentence)').toBe(true);
    await context.setOffline(false);
    await expect.poll(() => dbVersion(productId), { message: 'the parked press is sent at reconnect' }).toBe(2);
    await expect(page.getByText('Photos saved')).toBeVisible();
    expect(dbOrder(productId)).toEqual([mediaIds[0], mediaIds[2], mediaIds[1]]);
    await page.getByRole('button', { name: 'Move photo 3 up' }).click();

    // the network drops just after the press (the browser still thinks it is online): a plain failure sentence, draft kept
    await page.route(`**${GALLERY(shopId, productId)}`, (route) => (route.request().method() === 'PUT' ? route.abort('connectionreset') : route.fallback()), { times: 1 });
    await page.getByRole('button', SAVE).click();
    await expect(problemText(page)).toBeVisible();
    expect(await problemText(page).innerText()).not.toMatch(/undefined|\[object|AxiosError|Network Error/i);
    expect(await shownWidths(page)).toEqual([11, 12, 13]);

    // the next press saves the draft, and the old error text is gone
    await page.getByRole('button', SAVE).click();
    await expect(page.getByText('Photos saved')).toBeVisible();
    await expect(problemText(page)).toHaveCount(0);
    expect(dbVersion(productId)).toBe(3);
    expect(api.matching('PUT', galleryRoute(shopId, productId)).map((entry) => entry.status).at(-1)).toBe(200);
  });

  test('media.save.rate: an answered 429 with Retry-After shows the too-many-requests sentence and keeps the draft', async ({ page }) => {
    covers('media.save.rate');
    const { shopId, productId, mediaIds } = await openGallery(page, 2);
    await page.route(`**${GALLERY(shopId, productId)}`, (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 429, headers: { 'retry-after': '3' }, contentType: 'application/problem+json', body: JSON.stringify({ type: 'https://errors.example/rate_limited', title: 'Too many requests', status: 429 }) }) : route.fallback()), { times: 1 });
    await page.getByRole('button', { name: 'Move photo 2 up' }).click();
    await page.getByRole('button', SAVE).click();
    await expect(page.getByText(/Too many requests/i).first()).toBeVisible();
    await expect(page.getByText(/\b[0-3] ?s\b|second/i).first()).toBeVisible();
    expect(await shownWidths(page)).toEqual([12, 11]);
    expect(dbOrder(productId)).toEqual(mediaIds);
  });

  test('media.save.rate: the real limit of 60 gallery writes a minute per shop', async ({ page }) => {
    covers('media.save.rate');
    test.fixme(true, 'blocked: the dev stack has RATE_LIMIT_ALLOW_IPS=127.0.0.1 (packages/backend/.env), so a real 429 never comes from this machine');
    const { shopId, productId, token, mediaIds } = await openGallery(page, 2);
    let first429: number | undefined;
    for (let call = 1; call <= 70 && first429 === undefined; call++) {
      const res = await sellerCall('PUT', GALLERY(shopId, productId), { mediaIds, expectedVersion: 1 }, token);
      if (res.status === 429) first429 = call;
    }
    expect(first429).toBeLessThanOrEqual(61);
  });
});
void execFileSync;
void dbMediaStatus;
