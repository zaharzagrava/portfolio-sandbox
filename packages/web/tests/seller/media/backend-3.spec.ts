import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { API_URL, sellerCall } from '../../helpers';
import { ownerWithShop, uniqueTitle } from '../cross-cutting/support';
import { rows, scalar } from '../support/db';
import { MEDIA_GET, dbMediaStatus, mediaPath, openGallery } from './edit-support';
import { greyPng, photo, pixel, uploadReady, uploadsOf } from './support';

/**
 * AI QA, area "media", pass 3: the photo service behind the page (map lines `media.be.*`): the batch read, the storage key and
 * the signed permission, the storage itself, status history, a poison file (fifth try), a hostile file name.
 */

function covers(...ids: string[]) {
  test.info().annotations.push({ type: 'aiqa-lines', description: ids.join(',') });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const s3sdk: any = createRequire(path.join(__dirname, '../../../../backend/package.json'))('@aws-sdk/client-s3');
const s3 = new s3sdk.S3Client({ endpoint: 'http://localhost:9100', region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' } });
const sql = (query: string) => execFileSync('docker', ['exec', '-i', 'payment_system_db', 'psql', '-U', 'postgres', '-d', 'marketplace', '-c', query]);
const derived0 = (variants: string): string => Object.values(JSON.parse(variants) as Record<string, { key: string }>)[0].key;
const get = (route: string, token?: string) => fetch(`${API_URL}${route}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

type Started = { mediaId: string; upload: { url: string; fields: Record<string, string> } };
const start = async (token: string, shopId: string): Promise<Started> => {
  const started = await sellerCall('POST', `/api/shops/${shopId}/media/uploads`, { purpose: 'product' }, token);
  expect(started.status, JSON.stringify(started.data)).toBe(201);
  return started.data;
};
const post = (started: Started, bytes: Buffer, type: string) => {
  const form = new FormData();
  for (const [name, value] of Object.entries(started.upload.fields)) form.append(name, value);
  form.append('Content-Type', type);
  form.append('file', new Blob([new Uint8Array(bytes)], { type }), 'photo');
  return fetch(started.upload.url, { method: 'POST', body: form });
};

test.describe('Photo service: batch, keys, signed permission, storage, history', () => {
  test('media.be.batch: answers in request order, null for a photo that is not READY, at most 100 ids', async ({ page }) => {
    covers('media.be.batch');
    test.setTimeout(120_000);
    const { shopId, token } = await ownerWithShop(page, []);
    const [a, b] = [await uploadReady(token, shopId, greyPng(15, 9)), await uploadReady(token, shopId, greyPng(16, 9))];
    const pending = (await start(token, shopId)).mediaId;
    const unknown = randomUUID();
    const answer = await get(`/api/batch/media?ids=${[b, pending, a, unknown].join(',')}`);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toMatch(/public/);
    const body = (await answer.json()) as ({ id: string } | null)[];
    expect(body, 'one entry per id').toHaveLength(4);
    expect(body[0]?.id).toBe(b);
    expect(body[1], 'not READY').toBeNull();
    expect(body[2]?.id).toBe(a);
    expect(body[3], 'unknown').toBeNull();
    expect(JSON.stringify(body)).not.toMatch(/originalKey|media\/original|uploaderId/);
    expect((await get(`/api/batch/media?ids=${Array.from({ length: 100 }, () => randomUUID()).join(',')}`)).status, '100 ids').toBe(200);
    expect((await get(`/api/batch/media?ids=${Array.from({ length: 101 }, () => randomUUID()).join(',')}`)).status, '101 ids').toBe(400);
    expect((await get('/api/batch/media?ids=')).status, 'empty').toBe(400);
    expect((await get('/api/batch/media?ids=nope')).status, 'not a uuid').toBe(400);
    expect((await get('/api/batch/media')).status, 'missing').toBe(400);
  });

  test('media.be.upload-key, media.be.signed-policy, media.be.late-upload, media.be.minio-bucket: the server picks the key; the storage enforces size, type and time; a second post changes nothing served', async ({ page }) => {
    covers('media.be.upload-key', 'media.be.signed-policy', 'media.be.late-upload', 'media.be.minio-bucket');
    test.setTimeout(180_000);
    const { shopId, token } = await ownerWithShop(page, []);
    const started = await start(token, shopId);
    // the key is chosen by the server and shown nowhere in the answers
    const key = scalar(`select "originalKey" from "Media" where id='${started.mediaId}'`);
    expect(key).toMatch(new RegExp(`^media/originals/shops/${shopId}/[0-9a-f-]{36}$`));
    expect(JSON.stringify(started).replace(started.upload.fields.key ?? '', ''), 'no storage key in the start answer apart from the signed form').not.toContain('originals/');
    const status = await sellerCall('GET', `/api/media/${started.mediaId}`, undefined, token);
    expect(JSON.stringify(status.data)).not.toMatch(/media\/originals|originalKey/);

    // the signed permission: expires in 600 s, size 1..15,728,640, image/ types
    const policy = JSON.parse(Buffer.from(started.upload.fields.Policy ?? started.upload.fields.policy, 'base64').toString());
    const seconds = (new Date(policy.expiration).getTime() - Date.now()) / 1000;
    expect(seconds, 'valid for about 600 s').toBeGreaterThan(540);
    expect(seconds).toBeLessThanOrEqual(605);
    expect(JSON.stringify(policy.conditions)).toMatch(/15728640/);
    expect(JSON.stringify(policy.conditions)).toMatch(/image\//);
    const tooBig = await post(started, Buffer.alloc(15_728_641, 1), 'image/png');
    expect(tooBig.status, 'a 16 MB body is refused by the storage').toBeGreaterThanOrEqual(400);
    const wrongType = await post(started, greyPng(5, 5), 'text/plain');
    expect(wrongType.status, 'text/plain is refused by the storage').toBeGreaterThanOrEqual(400);
    await expect(s3.send(new s3sdk.HeadObjectCommand({ Bucket: 'marketplace-media', Key: key })), 'nothing was stored by the refused posts').rejects.toBeTruthy();
    expect((await post(started, greyPng(5, 5), 'image/png')).status, 'the right file is taken').toBe(204);

    // finish it, then post a different file to the same key: the served picture does not change
    expect([200, 202]).toContain((await sellerCall('POST', `/api/media/${started.mediaId}/complete`, undefined, token)).status);
    await expect.poll(async () => (await sellerCall('GET', `/api/media/${started.mediaId}`, undefined, token)).data.status, { timeout: 60_000 }).toBe('READY');
    const before = { variants: scalar(`select variants::text from "Media" where id='${started.mediaId}'`), version: scalar(`select version from "Media" where id='${started.mediaId}'`) };
    const urlsBefore = JSON.stringify((await sellerCall('GET', `/api/media/${started.mediaId}`, undefined, token)).data.urls);
    const late = await post(started, greyPng(60, 60), 'image/png');
    void late; // the storage may take or refuse it; what is served must not change
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(scalar(`select variants::text from "Media" where id='${started.mediaId}'`)).toBe(before.variants);
    expect(scalar(`select version from "Media" where id='${started.mediaId}'`)).toBe(before.version);
    expect(dbMediaStatus(started.mediaId)).toBe('READY');
    expect(JSON.stringify((await sellerCall('GET', `/api/media/${started.mediaId}`, undefined, token)).data.urls)).toBe(urlsBefore);

    // the storage: the bucket exists, originals are private, derived files are the ones the pictures come from
    const listed = await s3.send(new s3sdk.ListObjectsV2Command({ Bucket: 'marketplace-media', Prefix: 'media/derived/', MaxKeys: 1 }));
    expect(listed.KeyCount, 'derived files exist').toBeGreaterThan(0);
    const original = await fetch(`http://localhost:9100/marketplace-media/${key}`);
    expect(original.status, 'an original cannot be read without a key').toBeGreaterThanOrEqual(400);
    void derived0(before.variants);
  });

  test('media.be.minio-bucket: a derived file is readable through the media address, an original is not', async ({ page }) => {
    covers('media.be.minio-bucket');
    const { shopId, token } = await ownerWithShop(page, []);
    const mediaId = await uploadReady(token, shopId, greyPng(33, 19));
    const derived = derived0(scalar(`select variants::text from "Media" where id='${mediaId}'`));
    const urls = (await sellerCall('GET', `/api/media/${mediaId}`, undefined, token)).data.urls as Record<string, string>;
    const direct = await fetch(`http://localhost:9100/marketplace-media/${derived}`);
    expect(direct.status, 'B-002 / P1F4: the derived file is public on the storage (it answers 403 here)').toBe(200);
    expect((await fetch(urls.thumb)).status, 'and the address the API gives loads').toBe(200);
  });

  test('media.be.status-transitions: every move of a photo has one history row, in a legal order', async ({ page }) => {
    covers('media.be.status-transitions');
    test.setTimeout(180_000);
    const { shopId, token } = await ownerWithShop(page, []);
    const ready = await uploadReady(token, shopId, greyPng(21, 13));
    const deleted = await uploadReady(token, shopId, greyPng(22, 13));
    expect((await sellerCall('DELETE', `/api/media/${deleted}`, undefined, token)).status).toBe(204);
    const refused = await (async () => {
      const started = await start(token, shopId);
      await post(started, Buffer.from('this is not a picture at all'), 'image/jpeg');
      await sellerCall('POST', `/api/media/${started.mediaId}/complete`, undefined, token);
      await expect.poll(() => dbMediaStatus(started.mediaId), { timeout: 60_000 }).toBe('REJECTED');
      return started.mediaId;
    })();
    const expiredId = (await start(token, shopId)).mediaId;
    sql(`update "Media" set status='EXPIRED' where id='${expiredId}'`);
    const chain = (id: string) => rows(`select coalesce("fromStatus",'-'), "toStatus", "actorType" from "MediaStatusHistory" where "mediaId"='${id}' order by "createdAt", id`).map((row) => `${row[0]}>${row[1]}`);
    expect(chain(ready)).toEqual(['-' + '>PENDING_UPLOAD', 'PENDING_UPLOAD>UPLOADED', 'UPLOADED>PROCESSING', 'PROCESSING>READY']);
    expect(chain(deleted)).toEqual(['-' + '>PENDING_UPLOAD', 'PENDING_UPLOAD>UPLOADED', 'UPLOADED>PROCESSING', 'PROCESSING>READY', 'READY>DELETED']);
    expect(chain(refused)).toEqual(['-' + '>PENDING_UPLOAD', 'PENDING_UPLOAD>UPLOADED', 'UPLOADED>PROCESSING', 'PROCESSING>REJECTED']);
    // the legal moves of the spec (12), checked on every row of this shop
    const legal = new Set(['-' + '>PENDING_UPLOAD', 'PENDING_UPLOAD>UPLOADED', 'PENDING_UPLOAD>EXPIRED', 'UPLOADED>PROCESSING', 'PROCESSING>READY', 'PROCESSING>REJECTED', 'PROCESSING>UPLOADED', 'UPLOADED>REJECTED', 'READY>DELETED', 'REJECTED>DELETED', 'PROCESSING>PROCESSING', 'UPLOADED>EXPIRED', 'EXPIRED>DELETED']);
    const all = rows(`select coalesce(h."fromStatus",'-')||'>'||h."toStatus" from "MediaStatusHistory" h join "Media" m on m.id=h."mediaId" where m."shopId"='${shopId}'`).map((row) => row[0]);
    for (const move of all) expect(legal.has(move), `move ${move} is a listed move`).toBe(true);
    // DELETED is final: nothing leaves it
    expect(all.filter((move) => move.startsWith('DELETED>'))).toEqual([]);
    // a deleted photo cannot come back through the API
    expect((await sellerCall('POST', `/api/media/${deleted}/complete`, undefined, token)).status).toBeGreaterThanOrEqual(400);
    expect(dbMediaStatus(deleted)).toBe('DELETED');
    void expiredId;
  });

  test('media.be.attempts: a file the worker has already tried four times is refused on the fifth, and the row says so', async ({ page }) => {
    covers('media.be.attempts');
    test.setTimeout(180_000);
    const { shopId, productId } = await openGallery(page, 0);
    // before the page asks the worker (the "complete" call), the row is told it has been tried four times
    await page.route(/\/api\/media\/[0-9a-f-]{36}\/complete$/, async (route) => {
      const id = new URL(route.request().url()).pathname.split('/')[3];
      sql(`update "Media" set attempts=4 where id='${id}'`);
      await route.continue();
    });
    await page.getByLabel('Add photos').setInputFiles(pixel('poison.png'));
    const row = uploadsOf(page).getByRole('listitem').first();
    await expect(row.getByRole('alert')).toHaveText("We couldn't process that image. Try another file.", { timeout: 60_000 });
    const media = rows(`select id, status, "rejectCode", attempts from "Media" where "shopId"='${shopId}'`)[0];
    expect(media.slice(1)).toEqual(['REJECTED', 'processing_failed', '5']);
    expect(scalar(`select count(*) from "Outbox" where type='media.rejected' and "aggregateId"='${media[0]}' and payload->'payload'->>'code'='processing_failed'`)).toBe('1');
    expect(scalar(`select count(*) from "ProductMedia" where "productId"='${productId}'`), 'nothing joined the gallery').toBe('0');
  });

  test('media.be.sec.xss-name: a hostile file name is shown as text', async ({ page }) => {
    covers('media.be.sec.xss-name');
    test.setTimeout(120_000);
    await openGallery(page, 0);
    const name = '<img src=x onerror=window.__pwned=1>.png';
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => void dialogs.push(dialog.message()));
    await page.getByLabel('Add photos').setInputFiles(photo(name, greyPng(12, 12), 'image/png'));
    const row = uploadsOf(page).getByRole('listitem').first();
    await expect(row).toContainText(name);
    expect(await row.locator('img').count(), 'the name made no element').toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned), 'no handler ran').toBeUndefined();
    expect(dialogs).toEqual([]);
  });

  test('media.be.sec.path-ids: malformed shop or product ids answer 400 before the database', async ({ page }) => {
    covers('media.be.sec.path-ids');
    const { shopId, productIds, token } = await ownerWithShop(page, [{ title: uniqueTitle('Ids') }]);
    const bad = ['not-a-uuid', '123', '%00', 'x'.repeat(300), '..%2F..%2Fetc', "1'--"];
    for (const id of bad) {
      for (const [method, route, body] of [
        ['GET', `/api/shops/${id}/products/${productIds[0]}/gallery`, undefined],
        ['GET', `/api/shops/${shopId}/products/${id}/gallery`, undefined],
        ['PUT', `/api/shops/${id}/products/${productIds[0]}/gallery`, { mediaIds: [], expectedVersion: 0 }],
        ['PUT', `/api/shops/${shopId}/products/${id}/gallery`, { mediaIds: [], expectedVersion: 0 }],
        ['POST', `/api/shops/${id}/media/uploads`, { purpose: 'product' }],
        ['GET', `/api/products/${id}/gallery`, undefined],
      ] as const) {
        const answer = await sellerCall(method, route, body, token);
        expect([400, 404], `${method} ${route.slice(0, 60)}`).toContain(answer.status);
        if (id !== '%00' && !id.includes('%2F')) expect(answer.status, `${method} ${route.slice(0, 60)}`).toBe(400);
      }
    }
    expect(scalar(`select count(*) from "Media" where "shopId"='${shopId}'`)).toBe('0');
    void MEDIA_GET;
    void mediaPath;
  });
});
