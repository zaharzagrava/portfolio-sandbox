import { expect, type Page, type Route } from '@playwright/test';
import { sellerCall, shopPath } from '../../helpers';
import { ownerWithShop, readGallery, uniqueTitle } from '../cross-cutting/support';
import { rows, scalar } from '../support/db';
import { greyPng, uploadReady } from './support';

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

/** Uploads `count` distinguishable photos (not attached to anything yet); returns their media ids in the order made. */
export async function makePhotos(token: string, shopId: string, count: number, offset = 0): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) ids.push(await uploadReady(token, shopId, greyPng(widthOf(offset + index), 10)));
  return ids;
}

/** A gallery of `count` distinguishable photos saved through the API (version 0 -> 1). */
export async function savedGallery(token: string, shopId: string, productId: string, count: number): Promise<string[]> {
  const mediaIds = await makePhotos(token, shopId, count);
  const saved = await sellerCall('PUT', GALLERY(shopId, productId), { mediaIds, expectedVersion: 0 }, token);
  expect(saved.status, `fill gallery: ${JSON.stringify(saved.data)}`).toBe(200);
  return mediaIds;
}

/** An owner with one product, `count` saved photos and the photos page open. */
export async function openGallery(page: Page, count: number) {
  const owner = await ownerWithShop(page, [{ title: uniqueTitle('Gallery Edit') }]);
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

