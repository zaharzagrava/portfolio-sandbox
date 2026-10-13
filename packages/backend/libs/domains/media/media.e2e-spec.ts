import sharp from 'sharp';
import {
  mediaCompleteResponseSchema,
  mediaOwnerSchema,
  mediaPublicSchema,
  mediaUploadResponseSchema,
  type MediaUploadResponse,
} from '@marketplace-sandbox/contracts';
import type { TestUser } from '@app/test/utils/catalog-app';
import {
  createMediaApp,
  type MediaTestApp,
  type MediaWorld,
} from './testing/media-app';
import { duplicatePair, phpScript, photo } from './testing/test-images';

/**
 * The photo journey end to end through the real API, the real object store and the worker core: presign, browser POST,
 * `complete`, processing, read. The scenario-level suites (`media-upload`, `media-processing`, `media-duplicates`, …)
 * prove each rule on its own; this file keeps the three walks the first version of this capability had (L-017) and walks
 * them through the new routes.
 */
describe('Media pipeline (e2e)', () => {
  let t: MediaTestApp;
  let w: MediaWorld;

  beforeAll(async () => {
    t = await createMediaApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    w = await t.world();
  });

  const presign = async (user: TestUser, shopId: string) =>
    mediaUploadResponseSchema.parse(
      (
        await t
          .as(user)
          .post(`/api/shops/${shopId}/media/uploads`)
          .send({ purpose: 'product' })
          .expect(201)
      ).body,
    );
  const browserPost = (
    upload: MediaUploadResponse['upload'],
    bytes: Buffer,
    contentType = 'image/jpeg',
  ) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(upload.fields))
      form.append(name, value);
    form.append('Content-Type', contentType);
    form.append(
      'file',
      new Blob([new Uint8Array(bytes)], { type: contentType }),
      'x',
    );
    return fetch(upload.url, { method: 'POST', body: form });
  };
  const upload = async (user: TestUser, shopId: string, bytes: Buffer) => {
    const created = await presign(user, shopId);
    expect((await browserPost(created.upload, bytes)).status).toBeLessThan(300);
    const done = await t
      .as(user)
      .post(`/api/media/${created.mediaId}/complete`)
      .expect(202);
    expect(mediaCompleteResponseSchema.parse(done.body).status).toBe(
      'UPLOADED',
    );
    return { id: created.mediaId, key: created.upload.fields.key };
  };

  it('S29 AS-01: presigned POST: server-chosen key under the shop, a closed content-type family, the 15 MiB cap - the API never sees bytes', async () => {
    const created = await presign(w.staff, w.shop.id);
    const row = (await t.row(created.mediaId))!;
    expect(row.originalKey).toBe(created.upload.fields.key);
    expect(
      row.originalKey.startsWith(`media/originals/shops/${w.shop.id}/`),
    ).toBe(true);
    const policy = JSON.parse(
      Buffer.from(
        created.upload.fields.Policy ?? created.upload.fields.policy,
        'base64',
      ).toString(),
    );
    expect(JSON.stringify(policy.conditions)).toContain('content-length-range');
    expect(JSON.stringify(policy.conditions)).toContain('15728640');
    expect(JSON.stringify(policy.conditions)).toContain('image/');
    expect(created.maxBytes).toBe(15 * 1024 * 1024);
    expect(await t.objectExists(created.upload.fields.key)).toBe(false); // nothing has been uploaded through the API
    const refused = await browserPost(
      created.upload,
      Buffer.alloc(15 * 1024 * 1024 + 1, 7),
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await t.objectExists(created.upload.fields.key)).toBe(false);
    expect(
      (
        await browserPost(
          created.upload,
          await photo({ width: 64, height: 64 }),
        )
      ).status,
    ).toBeLessThan(300);
    expect(await t.objectExists(created.upload.fields.key)).toBe(true);
  });

  it('S29 AS-12: processing: READY with stripped-metadata WebP variants, an outbox event and an idempotent re-run; garbage is REJECTED', async () => {
    const good = await upload(
      w.staff,
      w.shop.id,
      await photo({
        width: 2400,
        height: 1600,
        withMetadata: true,
        seed: Math.floor(Math.random() * 1e9) + 1,
      }),
    );
    const processor = t.processor();
    expect(await processor.process(good.key)).toBe('READY');
    const row = (await t.row(good.id))!;
    const variants = row.variants as Record<
      string,
      { key: string; width: number }
    >;
    expect(Object.keys(variants).sort()).toEqual(['feed', 'full', 'thumb']);
    for (const v of Object.values(variants)) {
      const meta = await sharp(await t.objectBytes(v.key)).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.exif).toBeUndefined();
    }
    expect(variants.full.width).toBe(1600);
    expect(await t.outbox('media.ready')).toHaveLength(1);
    expect(await processor.process(good.key)).toBe('SKIPPED'); // a duplicate delivery changes nothing
    expect(await t.outbox('media.ready')).toHaveLength(1);
    const view = mediaPublicSchema.parse(
      (await t.http().get(`/api/media/${good.id}`).expect(200)).body,
    );
    expect(view.urls.full).toContain(variants.full.key);

    const bad = await upload(w.staff, w.shop.id, phpScript());
    expect(await processor.process(bad.key)).toBe('REJECTED');
    const rejected = mediaOwnerSchema.parse(
      (await t.as(w.staff).get(`/api/media/${bad.id}`).expect(200)).body,
    );
    expect(rejected).toMatchObject({
      status: 'REJECTED',
      rejectCode: 'not_an_image',
      urls: null,
    });
    await t.http().get(`/api/media/${bad.id}`).expect(404);
  });

  it("S29 AS-25: a re-saved copy of another shop's photo is flagged as a possible duplicate, privately", async () => {
    const pair = await duplicatePair();
    const first = await upload(w.staff, w.shop.id, pair.original);
    const copy = await upload(w.otherOwner, w.otherShop.id, pair.copy);
    const processor = t.processor();
    expect(await processor.process(first.key)).toBe('READY');
    expect(await processor.process(copy.key)).toBe('READY');
    expect((await t.row(copy.id))!.possibleDuplicateOf).toBe(first.id);
    expect((await t.row(first.id))!.possibleDuplicateOf).toBeNull();
    const body = JSON.stringify(
      (await t.as(w.otherOwner).get(`/api/media/${copy.id}`).expect(200)).body,
    );
    expect(body).not.toContain(first.id);
    expect(body).not.toMatch(/duplicate/i);
    expect(await t.outbox('media.duplicate_suspected')).toHaveLength(1);
  });
});
