import { deflateSync, crc32 } from 'node:zlib';
import { expect, type Page, type Route } from '@playwright/test';
import { NEW_USER_PASSWORD, sellerCall, seedProduct, shopPath } from '../helpers';
import { PIXEL_PNG, ownerWithShop, readGallery, uniqueTitle } from '../seller/cross-cutting/support';
import { rows, scalar } from '../seller/support/db';

/**
 * Shared pieces of the AI QA specs of the photos page (`media-page.spec.ts`, `media-upload.spec.ts`): the files a seller could
 * choose, and the signed three-step upload done through the API (the same three calls the page makes) so a spec can fill a
 * gallery without clicking twenty times. Product code is never imported; the page is judged only by what it shows and sends.
 */

/** A real 50 x 50 animated WebP (4 frames): the worker must refuse it as `multi_frame`. */
export const ANIMATED_WEBP = Buffer.from(
  'UklGRqoBAABXRUJQVlA4WAoAAAACAAAAMQAAMQAAQU5JTQYAAAAAAAAAAABBTk1GTgAAAAAAAAAAADEAADEAAGQAAAJWUDggNgAAANADAJ0BKjIAMgAuTTabTaEkJCQEAExLSDFAABKzKGcfnBlA+DJcAAD+/Tct7W5fejV8m+AAAEFOTUZYAAAAAAAAAAAAMQAAMQAAZAAAAFZQOCBAAAAAtAMAnQEqMgAyAD5tMpJJAiAAANiWkGKAACViVa0mVX8OyoZJyAAA/vqaD+ho0/D/6182dvwH1PWbn1d8ZhAAAEFOTUZeAAAAAAAAAAAAMQAAMQAAZAAAAFZQOCBGAAAAlAMAnQEqMgAyAD5tMpJJAiAAANiWkGKAACdCV9Tp6r83r35u0AD++ZNv/VVPX43f//EOf1t/3KbFPTbhnMdNszkGz1CAAEFOTUZiAAAAAAAAAAAAMQAAMQAAZAAAAFZQOCBKAAAA1AMAnQEqMgAyAD5tMpJJAiAAANiWkGKACZAAhXstVF5TUfk1cS/AAP74X3//XwBT9n//+emf+CT/4JPzM7XpvCXrK68oAKAEAAA=',
  'base64',
);

/** A real 400 x 300 AVIF still image. */
export const STILL_AVIF = Buffer.from(
  'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUEAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAA0AAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAGQAAABLAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EgAAAAAAATY29scm5jbHgAAgACAACAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAA8bWRhdAoNIAAABEY+Vn/80BDQAjIjEACQAAAAoAAAgAHFeCMCEtnjJVXs57yZ620pYpLMxNbmC5I=',
  'base64',
);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** A grey PNG of the given size (flat colour, so it stays small even when huge). `frames` > 1 makes an animated PNG (APNG). */
export function greyPng(width: number, height: number, frames = 1): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(0, 9); // grey
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, 128)]);
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y++) row.copy(raw, y * row.length);
  const packed = deflateSync(raw, { level: 9 });
  const parts = [SIGNATURE, chunk('IHDR', header)];
  if (frames > 1) {
    const control = Buffer.alloc(8);
    control.writeUInt32BE(frames, 0);
    parts.push(chunk('acTL', control));
  }
  const frameControl = (sequence: number) => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence, 0);
    data.writeUInt32BE(width, 4);
    data.writeUInt32BE(height, 8);
    data.writeUInt16BE(1, 20); // delay numerator
    data.writeUInt16BE(10, 22); // delay denominator
    return chunk('fcTL', data);
  };
  if (frames > 1) parts.push(frameControl(0));
  parts.push(chunk('IDAT', packed));
  for (let frame = 1; frame < frames; frame++) {
    parts.push(frameControl(frame * 2 - 1));
    const data = Buffer.concat([Buffer.alloc(4), packed]);
    data.writeUInt32BE(frame * 2, 0);
    parts.push(chunk('fdAT', data));
  }
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

export const photo = (name: string, buffer: Buffer, mimeType: string) => ({ name, mimeType, buffer });
export const pixel = (name = 'pixel.png') => photo(name, PIXEL_PNG, 'image/png');

/** The three calls of one photo upload through the API; returns the media id once the worker has made it READY. */
export async function uploadReady(token: string, shopId: string, buffer: Buffer = PIXEL_PNG, mimeType = 'image/png'): Promise<string> {
  const started = await sellerCall('POST', `/api/shops/${shopId}/media/uploads`, { purpose: 'product' }, token);
  expect(started.status, `start upload: ${JSON.stringify(started.data)}`).toBe(201);
  const form = new FormData();
  for (const [name, value] of Object.entries(started.data.upload.fields as Record<string, string>)) form.append(name, value);
  form.append('Content-Type', mimeType);
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), 'photo');
  const stored = await fetch(started.data.upload.url, { method: 'POST', body: form });
  expect(stored.status, 'the storage takes the signed form').toBe(204);
  const mediaId = started.data.mediaId as string;
  const completed = await sellerCall('POST', `/api/media/${mediaId}/complete`, undefined, token);
  expect([200, 202]).toContain(completed.status);
  await expect
    .poll(async () => (await sellerCall('GET', `/api/media/${mediaId}`, undefined, token)).data.status, { timeout: 60_000 })
    .toBe('READY');
  return mediaId;
}

/** Puts `count` ready photos into the product's gallery (one PUT, version 0 -> 1). */
export async function fillGallery(token: string, shopId: string, productId: string, count: number): Promise<string[]> {
  const mediaIds: string[] = [];
  for (let index = 0; index < count; index++) mediaIds.push(await uploadReady(token, shopId));
  const saved = await sellerCall('PUT', `/api/shops/${shopId}/products/${productId}/gallery`, { mediaIds, expectedVersion: 0 }, token);
  expect(saved.status, `fill gallery: ${JSON.stringify(saved.data)}`).toBe(200);
  return mediaIds;
}

/** The list of uploads under the chooser (rows still sending, waiting, or failed). */
export const uploadsOf = (page: Page) => page.getByRole('list', { name: 'Uploads' });
/** The photo cards in the draft list. */
export const photosOf = (page: Page) => page.getByRole('list', { name: 'Photos' }).getByRole('img');

/**
 * Pieces shared by the pass-2 specs of the photos page (`media-gallery-edit`, `media-gallery-save`, `media-upload-states`,
 * `media-backend`): a gallery of photos that can be told apart (each grey PNG has its own width, and the page prints the width
 * in the picture), the database reads, and one signed-in owner on the photos page.
 */

export const mediaPath = (shopId: string, productId: string) => `${shopPath(shopId, 'products')}/${productId}/media`;
export const GALLERY = (shopId: string, productId: string) => `/api/shops/${shopId}/products/${productId}/gallery`;
export const galleryRoute = (shopId: string, productId: string) => new RegExp(`^${GALLERY(shopId, productId)}$`);
export const STARTS = /^\/api\/shops\/[0-9a-f-]{36}\/media\/uploads$/;
export const COMPLETES = /^\/api\/media\/[0-9a-f-]{36}\/complete$/;
export const MEDIA_GET = /^\/api\/media\/[0-9a-f-]{36}$/;

/** The first photo is 11 px wide, the second 12 px and so on: the width printed by the page names the photo. */
export const widthOf = (index: number) => 11 + index;

/**
 * Uploads `count` distinguishable photos (not attached to anything yet); returns their media ids in the order made.
 * In the worker's shared shop (see `sharedOwner`) the photos are made once and reused by every test of the worker (a photo can sit
 * in the galleries of many products), so a test that needs three photos costs three uploads once per worker, not once per test.
 */
export async function makePhotos(token: string, shopId: string, count: number, offset = 0): Promise<string[]> {
  const pool = sharedPools.get(shopId);
  const make = (index: number) => uploadReady(token, shopId, greyPng(widthOf(index), 10));
  if (!pool) return Promise.all(Array.from({ length: count }, (_, index) => make(offset + index)));
  for (let index = offset; index < offset + count; index++) pool[index] ??= make(index);
  return Promise.all(pool.slice(offset, offset + count));
}
const sharedPools = new Map<string, Promise<string>[]>();

type Owner = Awaited<ReturnType<typeof ownerWithShop>>;
const sharedByWorker: { current?: Promise<Owner> } = {};
/**
 * One member with one shop per worker process, shared by the tests that only edit galleries (new product per test, same shop,
 * same finished photos). The page of each test is signed in as that member by the API. Tests that change the shop itself (status, roles,
 * limits per shop) ask for their own owner with `openGallery(page, count, { isolated: true })`.
 */
export async function sharedOwner(page: Page, products: { title: string }[]) {
  sharedByWorker.current ??= (async () => {
    const owner = await ownerWithShop(page, []);
    sharedPools.set(owner.shopId, []);
    return owner;
  })();
  const owner = await sharedByWorker.current;
  const signedIn = await page.request.post('/api/bff/session', { data: { email: owner.member.email, password: owner.member.password ?? NEW_USER_PASSWORD } });
  expect(signedIn.status(), 'sign in the shared owner').toBeLessThan(300);
  const productIds: string[] = [];
  for (const product of products) productIds.push(await seedProduct(owner.shopId, product, owner.member));
  return { ...owner, productIds };
}

/** A gallery of `count` distinguishable photos saved through the API (version 0 -> 1). */
export async function savedGallery(token: string, shopId: string, productId: string, count: number): Promise<string[]> {
  const mediaIds = await makePhotos(token, shopId, count);
  const saved = await sellerCall('PUT', GALLERY(shopId, productId), { mediaIds, expectedVersion: 0 }, token);
  expect(saved.status, `fill gallery: ${JSON.stringify(saved.data)}`).toBe(200);
  return mediaIds;
}

/** An owner with one product, `count` saved photos and the photos page open. */
export async function openGallery(page: Page, count: number, options: { isolated?: boolean } = {}) {
  const products = [{ title: uniqueTitle('Gallery Edit') }];
  // no photos to make: the member and shop are cheap, so a test that uploads in the page gets its own (upload limits are per user and shop)
  const owner = options.isolated || count === 0 ? await ownerWithShop(page, products) : await sharedOwner(page, products);
  const productId = owner.productIds[0];
  const mediaIds = count > 0 ? await savedGallery(owner.token, owner.shopId, productId, count) : [];
  await page.goto(mediaPath(owner.shopId, productId));
  await expect(page.getByText(`${count} of 20 photos`)).toBeVisible();
  return { ...owner, productId, mediaIds };
}

/** The widths printed by the photo cards, in the order shown (names the photos, see `widthOf`). */
export const shownWidths = (page: Page) => page.getByRole('list', { name: 'Photos' }).getByRole('img').evaluateAll((images) => images.map((image) => Number(image.getAttribute('width'))));
export const shownAlts = (page: Page) => page.getByRole('list', { name: 'Photos' }).getByRole('img').evaluateAll((images) => images.map((image) => image.getAttribute('alt')));

// ---------------------------------------------------------------- the database (read only)

/** The media ids the product holds in the database, by position. */
export const dbOrder = (productId: string): string[] => rows(`select "mediaId" from "ProductMedia" where "productId"='${productId}' order by position`).map((row) => row[0]);
export const dbPositions = (productId: string): string[] => rows(`select position from "ProductMedia" where "productId"='${productId}' order by position`).map((row) => row[0]);
export const dbVersion = (productId: string): number => Number(scalar(`select version from "ProductGallery" where "productId"='${productId}'`) || '0');
export const dbMediaStatus = (mediaId: string): string => scalar(`select status from "Media" where id='${mediaId}'`);
/** How many `media.gallery_changed` events the product has in the outbox. */
export const galleryEvents = (productId: string): number => Number(scalar(`select count(*) from "Outbox" where type='media.gallery_changed' and "aggregateId"='${productId}'`));
export const galleryEventPayloads = (productId: string): { mediaIds: string[]; galleryVersion: number }[] =>
  rows(`select payload->'payload' from "Outbox" where type='media.gallery_changed' and "aggregateId"='${productId}' order by "createdAt"`).map((row) => JSON.parse(row[0]));

export async function apiOrder(token: string, shopId: string, productId: string): Promise<string[]> {
  return (await readGallery(token, shopId, productId)).items.map((item) => item.mediaId);
}

/** Replaces the status (and reject code) that the page reads for a photo; `null` lets the real answer through. */
export async function fakeStatuses(page: Page, next: (call: number) => { status: string; rejectCode?: string } | null) {
  const times: number[] = [];
  await page.route(`**/api/media/*`, async (route: Route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || !MEDIA_GET.test(url.pathname)) return route.fallback();
    times.push(Date.now());
    const wanted = next(times.length);
    if (!wanted) return route.fallback();
    const real = await route.fetch();
    const body = await real.json();
    const now = new Date().toISOString();
    // the real answer of a finished photo is the public view; the owner's view of an unfinished one also has the two times
    const faked = wanted.status === 'READY' ? { ...body } : { ...body, createdAt: now, updatedAt: now, ...wanted };
    if (wanted.status !== 'READY') faked.urls = null;
    return route.fulfill({ response: real, json: faked });
  });
  return times;
}
