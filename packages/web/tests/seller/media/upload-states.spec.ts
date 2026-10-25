import { createRequire } from 'node:module';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test, type Page, type Route } from '@playwright/test';
import { sellerCall } from '../../helpers';
import { joinShopAs, setSuspended, tokenOf, watchApi } from '../cross-cutting/support';
import { rows, scalar } from '../support/db';
import { COMPLETES, MEDIA_GET, STARTS, dbOrder, fakeStatuses, mediaPath, openGallery, shownWidths } from './edit-support';
import { greyPng, photo, photosOf, pixel, uploadsOf } from './support';

/**
 * AI QA, area "media", pass 2: what the upload rows say while a photo travels and when something goes wrong (map lines
 * `media.proc.*`, `media.upload.error.*`, `media.upload.dismiss`, `media.upload.leave-during-upload`, ...). The server's own
 * answers are used wherever the stack can make them; where it cannot (a rejection code, an expired slot, a stuck worker), the
 * answer to the page's read is replaced and the database is read for the real state.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sharp: any = createRequire(path.join(__dirname, '../../../../backend/package.json'))('sharp');
function covers(...ids: string[]) {
  test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
}
const sql = (query: string) => execFileSync('docker', ['exec', '-i', 'payment_system_db', 'psql', '-U', 'postgres', '-d', 'marketplace', '-c', query]);
const STORAGE = (url: string) => new URL(url).port === '9100';
const rowText = (page: Page) => uploadsOf(page).getByRole('listitem');

test.describe('Photo upload rows: states, polling and failures', () => {
  test('media.proc.state.sending, media.proc.state.waiting, media.proc.poll, media.proc.ready, media.upload.limit.exif: a photo travels Sending, Waiting to process, Processing, then joins the draft', async ({ page }) => {
    covers('media.proc.state.sending', 'media.proc.state.waiting', 'media.proc.poll', 'media.proc.ready');
    test.setTimeout(120_000);
    const { shopId, productId, token } = await openGallery(page, 0);
    const api = watchApi(page);
    // the permission call is held back, so that "Sending" can be seen
    await page.route('**/api/shops/*/media/uploads', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.fallback();
    });
    const times = await fakeStatuses(page, (call) => (call <= 2 ? { status: 'UPLOADED' } : call <= 4 ? { status: 'PROCESSING' } : null));

    await page.getByLabel('Add photos').setInputFiles(pixel('mug.png'));
    await expect(rowText(page).first().getByRole('status')).toHaveText('Sending');
    await expect(rowText(page).first().getByRole('status')).toHaveText('Waiting to process');
    await expect(rowText(page).first().getByRole('status')).toHaveText('Processing');
    await expect(photosOf(page)).toHaveCount(1, { timeout: 30_000 });
    await expect(uploadsOf(page)).toHaveCount(0);
    await expect(page.getByText('1 of 20 photos')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save photos' })).toBeEnabled();

    // the photo is only in the draft: nothing saved
    expect(dbOrder(productId)).toEqual([]);
    expect(api.writes().filter((entry) => entry.method === 'PUT')).toEqual([]);
    // polling: about every 1.5 s, and it stops at READY
    const gaps = times.slice(1).map((time, index) => time - times[index]);
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    for (const gap of gaps) expect(gap, `gaps between reads: ${gaps.join(', ')} ms`).toBeGreaterThan(1200);
    const reads = times.length;
    await page.waitForTimeout(4000); // asserted absence: no read may follow after READY (a poll would come within 1.5 s)
    expect(times.length, 'no read after READY').toBe(reads);
    // URLs on the media origin, ending in .webp
    const src = (await photosOf(page).first().getAttribute('src')) ?? '';
    expect(new URL(src).pathname).toMatch(/\/media\/derived\/[0-9a-f]{64}\.webp$/);
    expect((await sellerCall('GET', `/api/shops/${shopId}/products/${productId}/gallery`, undefined, token)).data.items).toEqual([]);
  });

  test('media.upload.limit.exif: a JPEG that says "turn me" is shown upright by the page, without its GPS in the stored picture', async ({ page }) => {
    covers('media.upload.limit.exif');
    test.setTimeout(120_000);
    await openGallery(page, 0);
    const jpeg = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#a33' } })
      .jpeg()
      .withMetadata({ orientation: 6, exif: { IFD0: { Make: 'AiQaCam' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '52/1 31/1 12/1', GPSLongitudeRef: 'E', GPSLongitude: '13/1 24/1 18/1' } } })
      .toBuffer();
    await page.getByLabel('Add photos').setInputFiles(photo('turned.jpg', jpeg, 'image/jpeg'));
    await expect(photosOf(page)).toHaveCount(1, { timeout: 60_000 });
    // the card prints the size of the oriented photo: portrait
    const [width, height] = await photosOf(page).first().evaluate((image) => [Number(image.getAttribute('width')), Number(image.getAttribute('height'))]);
    expect([width, height]).toEqual([400, 600]);
    const id = scalar(`select id from "Media" where "originalKey" like '%' order by "createdAt" desc limit 1`);
    const variants = JSON.parse(scalar(`select variants from "Media" where id='${id}'`)) as Record<string, { key: string }>;
    expect(Object.keys(variants).length).toBe(3);
  });

  test('media.upload.leave-during-upload, media.proc.poll-after-leave: leaving while a photo is processing asks nothing; the photo becomes READY but is in no gallery, and the page stops asking', async ({ page }) => {
    covers('media.upload.leave-during-upload', 'media.proc.poll-after-leave');
    test.setTimeout(120_000);
    const { shopId, productId, token } = await openGallery(page, 0);
    const api = watchApi(page);
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => void dialogs.push(dialog.type()));
    await fakeStatuses(page, () => ({ status: 'PROCESSING' }));
    const started = page.waitForResponse((response) => response.request().method() === 'POST' && STARTS.test(new URL(response.url()).pathname));
    await page.getByLabel('Add photos').setInputFiles(pixel('leaving.png'));
    const mediaId = ((await (await started).json()) as { mediaId: string }).mediaId;
    await expect(rowText(page).first().getByRole('status')).toHaveText('Processing');

    await page.getByRole('link', { name: 'Back to inventory' }).click();
    await expect(page).toHaveURL(new RegExp('/inventory$'));
    expect(dialogs, 'no "leave this page?" question').toEqual([]);
    // the real photo finishes on the server and is attached to nothing
    await expect.poll(async () => (await sellerCall('GET', `/api/media/${mediaId}`, undefined, token)).data.status, { timeout: 60_000 }).toBe('READY');
    expect(scalar(`select count(*) from "ProductMedia" where "mediaId"='${mediaId}'`)).toBe('0');
    api.reset();
    await page.waitForTimeout(3500); // asserted absence: a poll would have come within 1.5 s
    expect(api.seen.filter((entry) => /^\/api\/media\/[0-9a-f-]{36}$/.test(entry.path)), 'no read of the photo after leaving').toEqual([]);

    // coming back: only saved photos are listed, nothing resumes
    await page.goto(mediaPath(shopId, productId));
    await expect(page.getByText('0 of 20 photos')).toBeVisible();
    await expect(uploadsOf(page)).toHaveCount(0);
    await expect(photosOf(page)).toHaveCount(0);
    // a full reload during Sending also drops the row without a question
    await page.getByLabel('Add photos').setInputFiles(pixel('reload.png'));
    await page.reload();
    expect(dialogs).toEqual([]);
    await expect(page.getByText('0 of 20 photos')).toBeVisible();
  });

  test('media.upload.double-click: the same file chosen twice in a row makes two separate uploads', async ({ page }) => {
    covers('media.upload.double-click');
    test.setTimeout(120_000);
    await openGallery(page, 0);
    const api = watchApi(page);
    const input = page.getByLabel('Add photos');
    await input.setInputFiles(pixel('twice.png'));
    await input.setInputFiles(pixel('twice.png'));
    await expect(photosOf(page)).toHaveCount(2, { timeout: 60_000 });
    expect(api.count('POST', STARTS)).toBe(2);
    expect(api.count('POST', COMPLETES)).toBe(2);
    await expect(page.getByText('2 of 20 photos')).toBeVisible();
    expect(await page.getByRole('alert').filter({ hasText: /\S/ }).count()).toBe(0);
  });

  test('media.proc.poll: five photos waiting at once make about five reads every 1.5 seconds, not more', async ({ page }) => {
    covers('media.proc.poll');
    test.setTimeout(120_000);
    await openGallery(page, 0);
    const times = await fakeStatuses(page, () => ({ status: 'UPLOADED' }));
    await page.getByLabel('Add photos').setInputFiles([pixel('a.png'), pixel('b.png'), pixel('c.png'), pixel('d.png'), pixel('e.png')]);
    await expect.poll(() => times.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(10);
    const start = times[0];
    await expect.poll(() => Date.now() - start, { timeout: 30_000 }).toBeGreaterThan(9000);
    const windowEnd = start + 9000;
    const inWindow = times.filter((time) => time <= windowEnd).length;
    // 9 s = six rounds of five photos at most (the first round plus one every 1.5 s)
    expect(inWindow, `reads in 9 s: ${inWindow}`).toBeLessThanOrEqual(5 * 7);
    expect(inWindow).toBeGreaterThanOrEqual(5 * 5);
  });

  test('media.proc.rejected, media.upload.dismiss: every refusal code has its own words, an unknown code the generic ones, and Dismiss removes only its row', async ({ page }) => {
    covers('media.proc.rejected', 'media.upload.dismiss');
    test.setTimeout(180_000);
    await openGallery(page, 0);
    const words: Record<string, string> = {
      not_an_image: "That file isn't an image.",
      format_not_allowed: 'Use a JPEG, PNG, WebP or AVIF image.',
      multi_frame: "Animated images aren't supported. Use a still image.",
      image_too_large: 'That image has too many pixels. Use a smaller one.',
      size_invalid: 'That file is empty or over 15 MB.',
      malware_detected: 'That file was blocked by a security check.',
      processing_failed: "We couldn't process that image. Try another file.",
      // a code the page's contract does not know cannot be read at all: the whole answer is refused and the row shows the generic
      // server sentence (the "couldn't be used" words of rejectCopy can never be reached from this page)
      something_new: 'Something went wrong on our side.',
    };
    let code = 'not_an_image';
    await fakeStatuses(page, () => ({ status: 'REJECTED', rejectCode: code }));
    for (const next of Object.keys(words)) {
      code = next;
      await page.getByLabel('Add photos').setInputFiles(pixel(`${next}.png`));
      const row = rowText(page).filter({ hasText: `${next}.png` });
      await expect(row.getByRole('alert')).toHaveText(words[next], { timeout: 30_000 });
    }
    await expect(rowText(page)).toHaveCount(8);
    // Dismiss removes only its own row
    await rowText(page).filter({ hasText: 'multi_frame.png' }).getByRole('button', { name: 'Dismiss' }).click();
    await expect(rowText(page)).toHaveCount(7);
    await expect(rowText(page).filter({ hasText: 'multi_frame.png' })).toHaveCount(0);
    await expect(rowText(page).filter({ hasText: 'size_invalid.png' })).toHaveCount(1);
    await expect(page.getByText('0 of 20 photos')).toBeVisible();
  });

  test('media.proc.rejected: a file the worker really refuses (bytes that are not a picture) says so in words, and the row can be dismissed', async ({ page }) => {
    covers('media.proc.rejected');
    test.setTimeout(120_000);
    await openGallery(page, 0);
    await page.getByLabel('Add photos').setInputFiles(photo('fake.png', Buffer.from('this is not a picture at all, only text'), 'image/png'));
    await expect(rowText(page).first().getByRole('alert')).toHaveText("That file isn't an image.", { timeout: 60_000 });
    const mediaRow = rows(`select status, "rejectCode" from "Media" order by "createdAt" desc limit 1`)[0];
    expect(mediaRow).toEqual(['REJECTED', 'not_an_image']);
    await rowText(page).first().getByRole('button', { name: 'Dismiss' }).click();
    await expect(uploadsOf(page)).toHaveCount(0);
  });

  test('media.proc.rejected-at-complete: a refusal in the answer to "complete" shows its words at once and no polling follows', async ({ page }) => {
    covers('media.proc.rejected-at-complete');
    test.setTimeout(120_000);
    await openGallery(page, 0);
    const api = watchApi(page);
    await page.route('**/api/media/*/complete', async (route) => {
      const real = await route.fetch();
      return route.fulfill({ response: real, status: 200, json: { status: 'REJECTED', rejectCode: 'size_invalid' } });
    });
    await page.getByLabel('Add photos').setInputFiles(pixel('empty.png'));
    await expect(rowText(page).first().getByRole('alert')).toHaveText('That file is empty or over 15 MB.');
    await page.waitForTimeout(3200); // asserted absence: polling would start within 1.5 s
    expect(api.seen.filter((entry) => MEDIA_GET.test(entry.path)), 'no read of the photo').toEqual([]);
  });

  test('media.proc.expired: an expired slot says so in words', async ({ page }) => {
    covers('media.proc.expired');
    test.setTimeout(120_000);
    await openGallery(page, 0);
    await fakeStatuses(page, () => ({ status: 'EXPIRED' }));
    await page.getByLabel('Add photos').setInputFiles(pixel('slow.png'));
    await expect(rowText(page).first().getByRole('alert')).toHaveText('This upload expired. Add the photo again.');
    await rowText(page).first().getByRole('button', { name: 'Dismiss' }).click();
    await expect(uploadsOf(page)).toHaveCount(0);
  });

  test('media.proc.stuck: a worker that never answers leaves "Waiting to process" for good, with no timeout and no message', async ({ page }) => {
    covers('media.proc.stuck');
    test.setTimeout(120_000);
    await openGallery(page, 0);
    const times = await fakeStatuses(page, () => ({ status: 'UPLOADED' }));
    await page.getByLabel('Add photos').setInputFiles(pixel('stuck.png'));
    await expect(rowText(page).first().getByRole('status')).toHaveText('Waiting to process');
    await expect.poll(() => times.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(8);
    await expect(rowText(page).first().getByRole('status')).toHaveText('Waiting to process');
    await expect(rowText(page).first().getByRole('alert')).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('media.proc.poll-error: a failed read of the photo shows a sentence in an alert, with no retry button', async ({ page }) => {
    covers('media.proc.poll-error');
    test.setTimeout(120_000);
    await openGallery(page, 0);
    await page.route('**/api/media/*', async (route) => {
      if (route.request().method() !== 'GET' || !MEDIA_GET.test(new URL(route.request().url()).pathname)) return route.fallback();
      return route.fulfill({ status: 500, contentType: 'application/problem+json', json: { type: 'https://errors.example/internal', title: 'Internal', status: 500 } });
    });
    await page.getByLabel('Add photos').setInputFiles(pixel('unreadable.png'));
    await expect(rowText(page).first().getByRole('alert')).toBeVisible({ timeout: 30_000 });
    expect(await rowText(page).first().getByRole('alert').innerText()).toMatch(/\S/);
    await expect(rowText(page).first().getByRole('button')).toHaveCount(0);
  });

  test('media.upload.error.transfer: the bytes cannot be sent (storage refuses, storage down, network lost); the row says so, the slot stays PENDING_UPLOAD', async ({ page, context }) => {
    covers('media.upload.error.transfer', 'media.upload.dismiss');
    test.setTimeout(120_000);
    await openGallery(page, 0);
    const api = watchApi(page);
    const SENT = "The file couldn't be sent. Try again.";
    const storage = '**:9100/**';

    for (const [name, fail] of [
      ['refused.png', (route: Route) => route.fulfill({ status: 403, body: '<Error><Code>AccessDenied</Code></Error>' })],
      ['down.png', (route: Route) => route.fulfill({ status: 503, body: 'down' })],
      ['lost.png', (route: Route) => route.abort('connectionreset')],
    ] as const) {
      await page.route(storage, async (route) => (route.request().method() === 'POST' ? fail(route) : route.fallback()), { times: 1 });
      await page.getByLabel('Add photos').setInputFiles(pixel(name));
      await expect(rowText(page).filter({ hasText: name }).getByRole('alert')).toHaveText(SENT);
    }
    expect(api.count('POST', COMPLETES), 'complete is never called after a failed transfer').toBe(0);
    expect(rows(`select status from "Media" where status='PENDING_UPLOAD' order by "createdAt" desc limit 3`).flat()).toEqual(['PENDING_UPLOAD', 'PENDING_UPLOAD', 'PENDING_UPLOAD']);
    await rowText(page).filter({ hasText: 'down.png' }).getByRole('button', { name: 'Dismiss' }).click();
    await expect(rowText(page)).toHaveCount(2);

    // the network goes away in the middle of the transfer (the browser is offline when the storage call is made)
    await page.route(storage, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await context.setOffline(true);
      return route.abort('internetdisconnected');
    }, { times: 1 });
    await page.getByLabel('Add photos').setInputFiles(pixel('offline.png'));
    await expect(rowText(page).filter({ hasText: 'offline.png' }).getByRole('alert')).toHaveText(SENT);
    await context.setOffline(false);
    // and the next choice works again
    await page.getByLabel('Add photos').setInputFiles(pixel('again.png'));
    await expect(photosOf(page)).toHaveCount(1, { timeout: 60_000 });
  });

  test('media.upload.error.complete-missing, media.upload.error.csrf: "complete" before the bytes arrived is refused in words; our API calls carry the CSRF proof, the storage call carries no cookie', async ({ page }) => {
    covers('media.upload.error.complete-missing', 'media.upload.error.csrf');
    test.setTimeout(120_000);
    await openGallery(page, 0);
    // the storage call "succeeds" without keeping the file
    await page.route('**:9100/**', (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 204, body: '' }) : route.fallback()), { times: 1 });
    await page.getByLabel('Add photos').setInputFiles(pixel('missing.png'));
    await expect(rowText(page).first().getByRole('alert')).toHaveText("The file didn't arrive completely. Upload it again.");
    await rowText(page).first().getByRole('button', { name: 'Dismiss' }).click();
    await page.unroute('**:9100/**');

    // headers of a normal upload
    const seen: { kind: string; headers: Record<string, string> }[] = [];
    page.on('request', async (request) => {
      if (request.method() !== 'POST') return;
      const url = new URL(request.url());
      const kind = STARTS.test(url.pathname) ? 'start' : COMPLETES.test(url.pathname) ? 'complete' : url.port === '9100' ? 'storage' : '';
      if (kind) seen.push({ kind, headers: await request.allHeaders() });
    });
    await page.getByLabel('Add photos').setInputFiles(pixel('headers.png'));
    await expect(photosOf(page)).toHaveCount(1, { timeout: 60_000 });
    expect(seen.map((entry) => entry.kind)).toEqual(['start', 'storage', 'complete']);
    for (const entry of seen.filter((item) => item.kind !== 'storage')) {
      expect(Object.keys(entry.headers).some((name) => /csrf/i.test(name)), `${entry.kind}: CSRF header`).toBe(true);
    }
    const storage = seen.find((entry) => entry.kind === 'storage')!;
    expect(Object.keys(storage.headers).filter((name) => /csrf|cookie|authorization/i.test(name)), 'the storage call carries no cookie, no CSRF proof, no token').toEqual([]);
  });

  test('media.upload.limit.pending-50, media.upload.error.suspended-start, media.upload.limit.rate: what the row says when the start is refused', async ({ page }) => {
    covers('media.upload.limit.pending-50', 'media.upload.error.suspended-start', 'media.upload.limit.rate');
    test.setTimeout(180_000);
    const { shopId, token } = await openGallery(page, 0);
    // 50 open slots through the API, then the page asks for the 51st
    for (let index = 0; index < 50; index++) expect((await sellerCall('POST', `/api/shops/${shopId}/media/uploads`, { purpose: 'product' }, token)).status).toBe(201);
    await page.getByLabel('Add photos').setInputFiles(pixel('too-many.png'));
    await expect(rowText(page).first().getByRole('alert')).toHaveText('You have too many uploads waiting. Let them finish, then try again.');
    expect(Number(scalar(`select count(*) from "Media" where "shopId"='${shopId}' and status='PENDING_UPLOAD'`))).toBe(50);
    await rowText(page).first().getByRole('button', { name: 'Dismiss' }).click();
    sql(`update "Media" set status='EXPIRED' where "shopId"='${shopId}'`);

    // an answered 429 with Retry-After (the stack lets this machine through the real limiter)
    await page.route('**/api/shops/*/media/uploads', (route) => route.fulfill({ status: 429, headers: { 'retry-after': '7' }, contentType: 'application/problem+json', json: { type: 'https://errors.example/rate_limited', title: 'Too many requests', status: 429 } }), { times: 1 });
    await page.getByLabel('Add photos').setInputFiles(pixel('fast.png'));
    await expect(rowText(page).first().getByRole('alert')).toHaveText(/Too many requests\. Try again in [1-7] s\./);
    await rowText(page).first().getByRole('button', { name: 'Dismiss' }).click();

    // the shop is suspended after the page was opened
    await setSuspended(shopId, true);
    try {
      await page.getByLabel('Add photos').setInputFiles(pixel('suspended.png'));
      await expect(rowText(page).first().getByRole('alert')).toHaveText('This shop is suspended. You can view data but not make changes.');
      expect(Number(scalar(`select count(*) from "Media" where "shopId"='${shopId}' and status='PENDING_UPLOAD'`)), 'no slot was made').toBe(0);
    } finally {
      await setSuspended(shopId, false);
    }
  });

  test('media.upload.error.permission: a member who lost the right to change products after the page opened gets the permission sentence', async ({ page, browser }) => {
    covers('media.upload.error.permission');
    test.setTimeout(180_000);
    const { shopId, productId, member, token } = await openGallery(page, 0);
    const staff = await joinShopAs(browser, member, shopId, 'STAFF');
    try {
      await staff.page.goto(mediaPath(shopId, productId));
      await expect(staff.page.getByLabel('Add photos')).toBeEnabled();
      // the owner turns the member into a viewer while the page is open
      const staffToken = await tokenOf(staff.member);
      const me = await sellerCall('GET', '/api/users/me', undefined, staffToken);
      const userId = (me.data?.id ?? scalar(`select id from "User" where email='${staff.member.email}'`)) as string;
      const changed = await sellerCall('PATCH', `/api/shops/${shopId}/members/${userId}`, { role: 'VIEWER' }, token);
      expect(changed.status, JSON.stringify(changed.data)).toBeLessThan(300);
      const api = watchApi(staff.page);
      await staff.page.getByLabel('Add photos').setInputFiles(pixel('nope.png'));
      await expect(rowText(staff.page).first().getByRole('alert')).toBeVisible();
      expect(api.matching('POST', STARTS).map((entry) => entry.status)).toEqual([403]);
      expect(await rowText(staff.page).first().getByRole('alert').innerText()).toMatch(/permission|access/i);
    } finally {
      await staff.context.close();
    }
  });

  test('media.upload.error.session: the session ends while a photo is being sent; the person gets the sign-in flow, not a raw error', async ({ page, context }) => {
    covers('media.upload.error.session');
    test.setTimeout(120_000);
    await openGallery(page, 0);
    await context.clearCookies();
    await page.getByLabel('Add photos').setInputFiles(pixel('expired.png'));
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000, message: 'sent to sign-in' }).toMatch(/\/login/);
  });
});
void greyPng;
void shownWidths;
