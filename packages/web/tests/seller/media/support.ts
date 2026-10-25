import { deflateSync, crc32 } from 'node:zlib';
import { expect, type Page } from '@playwright/test';
import { sellerCall } from '../../helpers';
import { PIXEL_PNG } from '../cross-cutting/support';

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
