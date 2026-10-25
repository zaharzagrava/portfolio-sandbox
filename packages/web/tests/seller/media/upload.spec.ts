import { expect, test, type Page } from '@playwright/test';
import { sellerCall, shopPath } from '../../helpers';
import { PIXEL_PNG, devMailboxLists, joinShopAs, ownerWithShop, setSuspended, uniqueTitle, watchApi } from '../cross-cutting/support';
import { ANIMATED_WEBP, STILL_AVIF, fillGallery, greyPng, photo, photosOf, pixel, uploadReady, uploadsOf } from './support';

/**
 * AI QA, area "media", adding photos (map lines `media.upload.*`): what the chooser accepts, the three-step signed upload as
 * the page makes it, what the browser refuses before any request, what the worker refuses afterwards, many files at once,
 * the 20-photo limit, and what happens on a drop or a paste. Every test names its map lines in the title and in the
 * `aiqa-lines` annotation. The saved state is read back through the API with the member's own token.
 *
 * Needs the media worker of the dev stack (a photo only becomes READY through it). A video file is not used here.
 */

const mediaPath = (shopId: string, productId: string) => `${shopPath(shopId, 'products')}/${productId}/media`;
const STARTS = /^\/api\/shops\/[0-9a-f-]{36}\/media\/uploads$/;
const COMPLETES = /^\/api\/media\/[0-9a-f-]{36}\/complete$/;

function covers(...ids: string[]) {
  test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
}

/** One seller, one shop, one product, signed in, on the photos page of that product. */
async function openPhotos(page: Page, fill = 0) {
  const owner = await ownerWithShop(page, [{ title: uniqueTitle('Upload Target') }]);
  const productId = owner.productIds[0];
  const mediaIds = fill > 0 ? await fillGallery(owner.token, owner.shopId, productId, fill) : [];
  await page.goto(mediaPath(owner.shopId, productId));
  await expect(page.getByText(`${fill} of 20 photos`)).toBeVisible();
  return { ...owner, productId, mediaIds };
}

/** The ids of the media rows the page started, in order (read from the answers to the first upload call). */
function startedIds(page: Page) {
  const ids: string[] = [];
  page.on('response', (response) => {
    if (response.request().method() === 'POST' && STARTS.test(new URL(response.url()).pathname)) void response.json().then((body) => ids.push(body.mediaId as string));
  });
  return ids;
}

/** Waits for the worker's verdict on one media row and returns its status and reject code. */
async function verdictOf(token: string, mediaId: string): Promise<{ status: string; rejectCode?: string }> {
  await expect.poll(async () => (await sellerCall('GET', `/api/media/${mediaId}`, undefined, token)).data.status, { timeout: 60_000 }).toMatch(/READY|REJECTED/);
  return (await sellerCall('GET', `/api/media/${mediaId}`, undefined, token)).data;
}

test.describe('Photos upload: the chooser, the signed upload and the limits', () => {
  test('media.upload.input: the chooser takes several images of four types', async ({ page }) => {
    covers('media.upload.input');
    await openPhotos(page);
    const chooser = page.getByLabel('Add photos');
    await expect(chooser).toBeEnabled();
    await expect(chooser).toHaveAttribute('multiple', '');
    await expect(chooser).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp,image/avif');
  });

  test('media.upload.single-happy, media.upload.step1.permission, media.upload.step2.bytes, media.upload.step3.complete: one PNG goes through three calls and becomes a photo', async ({ page }) => {
    covers('media.upload.single-happy', 'media.upload.step1.permission', 'media.upload.step2.bytes', 'media.upload.step3.complete');
    const { shopId, token } = await openPhotos(page);
    const answers: { step: string; status: number; body: Record<string, unknown> | null }[] = [];
    page.on('response', async (response) => {
      const url = new URL(response.url());
      const method = response.request().method();
      if (method !== 'POST') return;
      const step = STARTS.test(url.pathname) ? 'start' : COMPLETES.test(url.pathname) ? 'complete' : url.port === '9100' ? 'storage' : '';
      if (!step) return;
      const text = await response.text().catch(() => '');
      answers.push({ step, status: response.status(), body: text ? (JSON.parse(text) as Record<string, unknown>) : null });
    });
    const ids = startedIds(page);

    await page.getByLabel('Add photos').setInputFiles(pixel('mug.png'));
    await expect(uploadsOf(page).getByText('mug.png')).toBeVisible();
    await expect(photosOf(page)).toHaveCount(1, { timeout: 60_000 });
    await expect(uploadsOf(page)).toHaveCount(0);
    await expect(page.getByText('1 of 20 photos')).toBeVisible();
    // the photo is only in the draft: nothing is saved until "Save photos"
    await expect(page.getByRole('button', { name: 'Save photos' })).toBeEnabled();
    expect((await sellerCall('GET', `/api/shops/${shopId}/products/${(await page.url()).split('/products/')[1].split('/')[0]}/gallery`, undefined, token)).data.items).toEqual([]);

    // step 1: the permission. 201, the media id, the signed form, the limits, and no property named "key" beside them
    const start = answers.find((entry) => entry.step === 'start');
    expect(start?.status).toBe(201);
    expect(Object.keys(start?.body ?? {}).sort()).toEqual(['allowedContentTypes', 'maxBytes', 'mediaId', 'upload']);
    expect(start?.body?.maxBytes).toBe(15_728_640);
    expect(start?.body?.allowedContentTypes).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
    // step 2: the browser's own POST to the storage, no cookie: the storage answers 204
    expect(answers.find((entry) => entry.step === 'storage')?.status).toBe(204);
    // step 3: confirm. 202 while the worker is busy
    expect(answers.find((entry) => entry.step === 'complete')?.status).toBe(202);
    expect(answers.map((entry) => entry.step), 'the order of the three calls').toEqual(['start', 'storage', 'complete']);

    // what is stored: the worker made it READY with its sizes and three picture sizes, in the member's shop
    const media = (await sellerCall('GET', `/api/media/${ids[0]}`, undefined, token)).data;
    expect(media).toMatchObject({ status: 'READY', purpose: 'product', shopId, width: 1, height: 1 });
    expect(Object.keys(media.urls).sort()).toEqual(['feed', 'full', 'thumb']);
  });

  test('media.upload.step2.bytes: the signed form refuses what its policy forbids', async ({ page }) => {
    covers('media.upload.step2.bytes');
    const { shopId, token } = await openPhotos(page);
    const started = await sellerCall('POST', `/api/shops/${shopId}/media/uploads`, { purpose: 'product' }, token);
    const send = async (type: string, bytes: Uint8Array) => {
      const form = new FormData();
      for (const [name, value] of Object.entries(started.data.upload.fields as Record<string, string>)) form.append(name, value);
      form.append('Content-Type', type);
      form.append('file', new Blob([bytes as BlobPart], { type }), 'x');
      return fetch(started.data.upload.url, { method: 'POST', body: form });
    };
    expect((await send('text/plain', new TextEncoder().encode('hi'))).status, 'a type that is not image/*').toBe(403);
    expect((await send('image/jpeg', new Uint8Array(15_728_641))).status, '15 MB + 1 byte').toBe(400);
    // the file never arrived, so the server does not accept the confirmation either
    const early = await sellerCall('POST', `/api/media/${started.data.mediaId}/complete`, undefined, token);
    expect(early.status).toBe(409);
    expect(early.data.type).toMatch(/upload_incomplete$/);
  });

  test('media.upload.storage-cors: the page may post to the storage (no connect-src block, no failed request)', async ({ page }) => {
    covers('media.upload.storage-cors');
    await page.addInitScript(() => {
      (window as unknown as { __blocked: string[] }).__blocked = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        if (event.effectiveDirective === 'connect-src' || event.effectiveDirective === 'form-action') (window as unknown as { __blocked: string[] }).__blocked.push(`${event.effectiveDirective} ${event.blockedURI}`);
      });
    });
    await openPhotos(page);
    const storage = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).port === '9100');
    await page.getByLabel('Add photos').setInputFiles(pixel());
    expect((await storage).status()).toBe(204);
    await expect(photosOf(page)).toHaveCount(1, { timeout: 60_000 });
    expect(await page.evaluate(() => (window as unknown as { __blocked: string[] }).__blocked)).toEqual([]);
  });

  test('media.upload.single-happy: the picture of a READY photo is served from the storage and shows in the page', async ({ page }) => {
    covers('media.upload.single-happy');
    // B-002: the API builds picture addresses from MEDIA_CDN_URL, which the dev stack points at port 9000 (ClickHouse), not the
    // storage on 9100 where the bytes are, and the page's CSP allows images only from the storage.
    await openPhotos(page);
    const origin = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).port === '9100').then((response) => new URL(response.url()).origin);
    await page.getByLabel('Add photos').setInputFiles(pixel());
    await expect(photosOf(page)).toHaveCount(1, { timeout: 60_000 });
    const image = photosOf(page).first();
    expect(new URL((await image.getAttribute('src')) ?? '').origin, 'the picture comes from the same storage the upload went to').toBe(await origin);
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0), { message: 'the picture really loads' }).toBe(true);
  });

  test('media.upload.step1.permission: who may ask for an upload slot', async ({ page, browser }) => {
    covers('media.upload.step1.permission');
    test.fixme(!(await devMailboxLists()), 'blocked: no dev outbox at /api/dev/mailbox, so a VIEWER cannot be invited');
    const { shopId, member, token } = await openPhotos(page);
    const route = `/api/shops/${shopId}/media/uploads`;
    expect((await sellerCall('POST', route, { purpose: 'product' })).status, 'signed out').toBe(401);
    expect((await sellerCall('POST', route, { purpose: 'nonsense' }, token)).status, 'a purpose that does not exist').toBe(400);
    const stranger = await browser.newContext();
    try {
      const other = await ownerWithShop(await stranger.newPage(), []);
      expect((await sellerCall('POST', route, { purpose: 'product' }, other.token)).status, 'another seller').toBe(404);
    } finally {
      await stranger.close();
    }
    const viewer = await joinShopAs(browser, member, shopId, 'VIEWER');
    try {
      await viewer.page.goto(mediaPath(shopId, (await page.url()).split('/products/')[1].split('/')[0]));
      await expect(viewer.page.getByRole('heading', { level: 1, name: 'Photos' })).toBeVisible();
      await expect(viewer.page.getByLabel('Add photos')).toHaveCount(0);
      await expect(viewer.page.getByRole('button', { name: 'Save photos' })).toHaveCount(0);
    } finally {
      await viewer.context.close();
    }
  });

  test('media.upload.input.disabled-full: with 20 photos the chooser is disabled and the page says why', async ({ page }) => {
    covers('media.upload.input.disabled-full');
    test.setTimeout(180_000);
    await openPhotos(page, 20);
    await expect(page.getByLabel('Add photos')).toBeDisabled();
    await expect(page.getByText('The gallery holds up to 20 photos.')).toBeVisible();
    await expect(photosOf(page)).toHaveCount(20);
  });

  test('media.upload.input.disabled-suspended: a suspended shop answers 403 shop_suspended to the gallery read (S29.R-21), so the page shows the suspended panel and no controls', async ({ page }) => {
    covers('media.upload.input.disabled-suspended');
    const { shopId, productId, token } = await openPhotos(page, 1);
    await setSuspended(shopId, true);
    try {
      const api = watchApi(page);
      await page.reload();
      await expect(page.getByText('This shop is suspended. You can view data but not make changes.').first()).toBeVisible();
      // the read itself is refused, as for the inventory and the orders of a suspended shop; nothing can be added or changed
      await expect.poll(() => api.matching('GET', new RegExp(`^/api/shops/${shopId}/products/${productId}/gallery$`)).map((entry) => entry.status)).toContain(403);
      await expect(page.getByLabel('Add photos')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Save photos' })).toHaveCount(0);
      await expect(photosOf(page)).toHaveCount(0);
      expect((await sellerCall('POST', `/api/shops/${shopId}/media/uploads`, { purpose: 'product' }, token)).status, 'no upload slot either').toBe(403);
    } finally {
      await setSuspended(shopId, false);
    }
    await page.reload();
    await expect(photosOf(page)).toHaveCount(1);
  });

  test('media.upload.many-files, media.upload.same-file-twice, media.upload.chooser-reset: five files at once, then the same file again', async ({ page }) => {
    covers('media.upload.many-files', 'media.upload.same-file-twice', 'media.upload.chooser-reset');
    const { token } = await openPhotos(page);
    const api = watchApi(page);
    const ids = startedIds(page);

    await page.getByLabel('Add photos').setInputFiles([pixel('a.png'), pixel('b.png'), pixel('c.png'), pixel('d.png'), pixel('e.png')]);
    // each file has its own row at once (they are sent in parallel)
    await expect(uploadsOf(page).getByRole('listitem')).toHaveCount(5);
    await expect(photosOf(page)).toHaveCount(5, { timeout: 60_000 });
    await expect(page.getByText('5 of 20 photos')).toBeVisible();
    await expect(uploadsOf(page)).toHaveCount(0);
    expect(api.count('POST', STARTS)).toBe(5);
    expect(api.count('POST', COMPLETES)).toBe(5);
    expect(new Set(ids).size, 'five separate media rows').toBe(5);
    // the chooser was cleared, so the same file can be chosen again
    expect(await page.getByLabel('Add photos').evaluate((input: HTMLInputElement) => input.files?.length)).toBe(0);

    await page.getByLabel('Add photos').setInputFiles(pixel('a.png'));
    await expect(photosOf(page)).toHaveCount(6, { timeout: 60_000 });
    expect(api.count('POST', STARTS), 'a file chosen twice is two uploads').toBe(6);
    await expect.poll(() => new Set(ids).size).toBe(6);
    for (const id of ids) expect((await sellerCall('GET', `/api/media/${id}`, undefined, token)).data.status).toBe('READY');
  });

  test('media.upload.many-files.over-room: more files than free room send only what fits and tell the person about the rest', async ({ page }) => {
    covers('media.upload.many-files.over-room');
    test.setTimeout(180_000);
    await openPhotos(page, 18);
    const api = watchApi(page);
    await page.getByLabel('Add photos').setInputFiles([pixel('1.png'), pixel('2.png'), pixel('3.png'), pixel('4.png'), pixel('5.png')]);
    await expect(photosOf(page)).toHaveCount(20, { timeout: 60_000 });
    expect(api.count('POST', STARTS), 'only the two that fit are sent').toBe(2);
    await expect(page.getByLabel('Add photos')).toBeDisabled();
    // three files were left out: the person must be told (S29.R-17), not left to count
    await expect(page.getByText(/3 (photos|files)/i)).toBeVisible();
  });

  test('media.upload.drag-drop, media.upload.paste: a dropped or pasted image starts no upload', async ({ page }) => {
    covers('media.upload.drag-drop', 'media.upload.paste');
    await openPhotos(page);
    const api = watchApi(page);
    const before = page.url();
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'drop.png', { type: 'image/png' }));
      const main = document.querySelector('main') as HTMLElement;
      for (const type of ['dragenter', 'dragover', 'drop']) main.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
      document.body.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    });
    await expect(page.getByText('0 of 20 photos')).toBeVisible();
    await expect(uploadsOf(page)).toHaveCount(0);
    expect(api.count('POST', STARTS)).toBe(0);
    expect(page.url()).toBe(before);
  });

  test('media.upload.limit.type-client, media.upload.limit.empty-client, media.upload.limit.size-client: the browser refuses before any request', async ({ page }) => {
    covers('media.upload.limit.type-client', 'media.upload.limit.empty-client', 'media.upload.limit.size-client', 'media.upload.limit.type-svg-gif', 'media.upload.limit.avif-heic');
    await openPhotos(page);
    const api = watchApi(page);
    const refused = [
      { file: photo('anim.gif', Buffer.from('GIF89a'), 'image/gif'), text: 'Use a JPEG, PNG, WebP or AVIF image.' },
      { file: photo('notes.txt', Buffer.from('hello'), 'text/plain'), text: 'Use a JPEG, PNG, WebP or AVIF image.' },
      { file: photo('logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'), text: 'Use a JPEG, PNG, WebP or AVIF image.' },
      { file: photo('phone.heic', Buffer.from('heic'), 'image/heic'), text: 'Use a JPEG, PNG, WebP or AVIF image.' },
      { file: photo('big.jpg', Buffer.alloc(15_728_641), 'image/jpeg'), text: 'Each photo can be up to 15 MB.' },
      { file: photo('empty.png', Buffer.alloc(0), 'image/png'), text: 'That file is empty.' },
    ];
    for (const { file, text } of refused) {
      await page.getByLabel('Add photos').setInputFiles(file);
      const row = uploadsOf(page).getByRole('listitem').filter({ hasText: file.name });
      await expect(row.getByRole('alert'), file.name).toHaveText(text);
      await row.getByRole('button', { name: 'Dismiss' }).click();
      await expect(row).toHaveCount(0);
    }
    expect(api.writes(), 'nothing was sent for any of them').toEqual([]);
    await expect(page.getByText('0 of 20 photos')).toBeVisible();
  });

  test('media.upload.limit.type-lie, media.upload.limit.size-client: a text file named .jpg and a file of exactly 15 MB reach the worker, which refuses them', async ({ page }) => {
    covers('media.upload.limit.type-lie', 'media.upload.limit.size-client');
    test.setTimeout(120_000);
    const { token } = await openPhotos(page);
    const ids = startedIds(page);
    const exactly15Mb = Buffer.alloc(15_728_640, 7);
    for (const [name, buffer] of [['lie.jpg', Buffer.from('this is not an image')], ['exact.jpg', exactly15Mb]] as const) {
      await page.getByLabel('Add photos').setInputFiles(photo(name, buffer, 'image/jpeg'));
      const row = uploadsOf(page).getByRole('listitem').filter({ hasText: name });
      await expect(row.getByRole('alert')).toHaveText("That file isn't an image.", { timeout: 60_000 });
      await row.getByRole('button', { name: 'Dismiss' }).click();
    }
    await expect.poll(() => ids.length).toBe(2);
    for (const id of ids) expect(await verdictOf(token, id)).toMatchObject({ status: 'REJECTED', rejectCode: 'not_an_image' });
    await expect(page.getByText('0 of 20 photos')).toBeVisible();
  });

  test('media.upload.limit.pixels: an image of 56 million pixels is refused by the worker', async ({ page }) => {
    covers('media.upload.limit.pixels');
    test.setTimeout(120_000);
    const { token } = await openPhotos(page);
    const ids = startedIds(page);
    await page.getByLabel('Add photos').setInputFiles(photo('wall.png', greyPng(8000, 7000), 'image/png'));
    const row = uploadsOf(page).getByRole('listitem').filter({ hasText: 'wall.png' });
    await expect(row.getByRole('alert')).toHaveText('That image has too many pixels. Use a smaller one.', { timeout: 60_000 });
    expect(await verdictOf(token, ids[0])).toMatchObject({ status: 'REJECTED', rejectCode: 'image_too_large' });
  });

  test('media.upload.limit.type-svg-gif: an animated WebP and an animated PNG are refused as moving images', async ({ page }) => {
    covers('media.upload.limit.type-svg-gif');
    test.setTimeout(120_000);
    const { token } = await openPhotos(page);
    const ids = startedIds(page);
    await page.getByLabel('Add photos').setInputFiles(photo('moving.webp', ANIMATED_WEBP, 'image/webp'));
    const webp = uploadsOf(page).getByRole('listitem').filter({ hasText: 'moving.webp' });
    await expect(webp.getByRole('alert')).toHaveText("Animated images aren't supported. Use a still image.", { timeout: 60_000 });
    expect(await verdictOf(token, ids[0])).toMatchObject({ status: 'REJECTED', rejectCode: 'multi_frame' });

    // S29.R-09: "one frame". An animated PNG has several; the worker must refuse it the same way.
    await page.getByLabel('Add photos').setInputFiles(photo('moving.png', greyPng(50, 50, 4), 'image/png'));
    await expect.poll(() => ids.length).toBe(2);
    expect(await verdictOf(token, ids[1])).toMatchObject({ status: 'REJECTED', rejectCode: 'multi_frame' });
  });

  test('media.upload.limit.avif-heic: an AVIF still image becomes a photo', async ({ page }) => {
    covers('media.upload.limit.avif-heic');
    const { token } = await openPhotos(page);
    const ids = startedIds(page);
    await page.getByLabel('Add photos').setInputFiles(photo('still.avif', STILL_AVIF, 'image/avif'));
    await expect(photosOf(page)).toHaveCount(1, { timeout: 60_000 });
    const media = (await sellerCall('GET', `/api/media/${ids[0]}`, undefined, token)).data;
    expect(media).toMatchObject({ status: 'READY', width: 400, height: 300 });
    expect(Object.keys(media.urls).sort()).toEqual(['feed', 'full', 'thumb']);
    expect(String(media.urls.thumb)).toMatch(/\.webp$/);
    expect(PIXEL_PNG.length).toBeGreaterThan(0);
    expect(await uploadReady(token, (await sellerCall('GET', `/api/media/${ids[0]}`, undefined, token)).data.shopId)).toBeTruthy();
  });
});
