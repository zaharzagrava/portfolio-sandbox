import { randomUUID } from 'node:crypto';
import { bands } from './domain/duplicate-match';
import { dHash } from './infra/image-pipeline';
import {
  createMediaApp,
  type MediaTestApp,
  type MediaWorld,
} from './testing/media-app';
import { duplicatePair, photo } from './testing/test-images';

const uniqueSeed = () => Math.floor(Math.random() * 2 ** 31) + 1;

describe('Media duplicate detection', () => {
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

  /** Puts `bytes` at a new upload slot and runs the worker on it. */
  const process = async (
    bytes: Buffer,
    owner: {
      shop: string | null;
      user: string;
      purpose?: 'product' | 'review';
    },
  ) => {
    const created = await t.photo({
      shopId: owner.shop,
      uploaderId: owner.user,
      purpose: owner.purpose ?? (owner.shop ? 'product' : 'review'),
      status: 'UPLOADED',
      uploadedAt: t.clock.now(),
    });
    await t.putOriginal(created.originalKey, bytes);
    return {
      ...created,
      result: await t.processor().process(created.originalKey),
    };
  };
  const shopA = () => ({ shop: w.shop.id, user: w.staff.id });
  const shopB = () => ({ shop: w.otherShop.id, user: w.otherOwner.id });

  it('S29 AS-25: a re-saved copy uploaded by another shop is READY, flagged privately, and nothing public says so', async () => {
    const pair = await duplicatePair();
    const first = await process(pair.original, shopA());
    expect(first.result).toBe('READY');
    const copy = await process(pair.copy, shopB());
    expect(copy.result).toBe('READY');

    const row = (await t.row(copy.id))!;
    expect(row).toMatchObject({
      status: 'READY',
      possibleDuplicateOf: first.id,
    });
    expect(row.duplicateDistance).toBeLessThanOrEqual(3);
    expect(row.duplicateAt).not.toBeNull();
    expect((await t.row(first.id))!.possibleDuplicateOf).toBeNull();

    const ready = (await t.outbox('media.ready')).find(
      (e) => e.payload.mediaId === copy.id,
    )!;
    expect(ready.payload.duplicateSuspected).toBe(true);
    expect(JSON.stringify(ready.payload)).not.toContain(first.id);
    const suspected = await t.outbox('media.duplicate_suspected');
    expect(suspected).toHaveLength(1);
    expect(suspected[0].payload).toEqual({
      mediaId: copy.id,
      shopId: w.otherShop.id,
      matchedMediaId: first.id,
      matchedShopId: w.shop.id,
      distance: row.duplicateDistance,
    });
    expect(t.metrics.count('media_duplicate_suspected_total')).toBe(1);

    // no response shows the suspicion: owner, public, batch, gallery
    const product = await t.product(w.otherShop.id);
    await t
      .as(w.otherOwner)
      .put(`/api/shops/${w.otherShop.id}/products/${product.id}/gallery`)
      .send({ mediaIds: [copy.id], expectedVersion: 0 })
      .expect(200);
    const bodies = [
      (await t.as(w.otherOwner).get(`/api/media/${copy.id}`).expect(200)).body,
      (await t.http().get(`/api/media/${copy.id}`).expect(200)).body,
      (await t.http().get(`/api/batch/media?ids=${copy.id}`).expect(200)).body,
      (await t.http().get(`/api/products/${product.id}/gallery`).expect(200))
        .body,
      (
        await t
          .as(w.otherOwner)
          .get(`/api/shops/${w.otherShop.id}/products/${product.id}/gallery`)
          .expect(200)
      ).body,
    ].map((b) => JSON.stringify(b));
    for (const body of bodies) {
      expect(body).not.toContain(first.id);
      expect(body).not.toContain(w.shop.id);
      expect(body).not.toMatch(/possibleDuplicate|duplicate|distance|dhash/i);
    }
  });

  it('S29 AS-26: a same-shop re-upload, an unrelated picture and a review photo are not flagged', async () => {
    const pair = await duplicatePair();
    await process(pair.original, shopA());
    const sameShop = await process(pair.copy, shopA());
    const unrelated = await process((await duplicatePair()).original, shopB());
    const review = await process(pair.copy, { shop: null, user: w.buyer.id });
    for (const p of [sameShop, unrelated, review]) {
      expect(p.result).toBe('READY');
      expect(await t.row(p.id)).toMatchObject({
        possibleDuplicateOf: null,
        duplicateDistance: null,
      });
    }
    expect((await t.row(review.id))!.dhash).toBeNull(); // review photos are neither hashed nor candidates
    expect(await t.outbox('media.duplicate_suspected')).toHaveLength(0);
    expect(
      (await t.outbox('media.ready')).every(
        (e) => e.payload.duplicateSuspected === false,
      ),
    ).toBe(true);
  });

  it('S29 AS-26: a product photo that matches only a review photo is not flagged', async () => {
    const pair = await duplicatePair();
    await process(pair.original, { shop: null, user: w.buyer.id });
    const product = await process(pair.copy, shopB());
    expect((await t.row(product.id))!.possibleDuplicateOf).toBeNull();
  });

  it.each(['REJECTED', 'DELETED', 'UPLOADED'] as const)(
    'S29 AS-26: a match only against a %s photo is not flagged',
    async (status) => {
      const pair = await duplicatePair();
      const first = await process(pair.original, shopA());
      await t.sql(`UPDATE "Media" SET "status" = :status WHERE "id" = :id`, {
        id: first.id,
        status,
      });
      const copy = await process(pair.copy, shopB());
      expect(copy.result).toBe('READY');
      expect((await t.row(copy.id))!.possibleDuplicateOf).toBeNull();
      expect(await t.outbox('media.duplicate_suspected')).toHaveLength(0);
    },
  );

  it('S29 AS-28: a band lookup that reaches 500 candidates is counted', async () => {
    const bytes = await photo({ width: 1200, height: 900, seed: uniqueSeed() });
    const [band0] = bands(await dHash(bytes));
    await t.sql(
      `INSERT INTO "Media" ("id","shopId","uploaderId","purpose","status","originalKey","variants","width","height","dhash","dhashB0","dhashB1","dhashB2","dhashB3")
       SELECT uuidv7(), :shop, :user, 'product', 'READY', 'media/originals/seed/' || g, '{"thumb":{"key":"k","width":1,"height":1},"feed":{"key":"k","width":1,"height":1},"full":{"key":"k","width":1,"height":1}}'::jsonb,
              10, 10, lpad(to_hex(:b0::int), 4, '0') || 'ffffffffffff', :b0, 65535, 65535, 65535
         FROM generate_series(1, 501) g`,
      { shop: randomUUID(), user: w.otherOwner.id, b0: band0 },
    );
    const mine = await process(bytes, shopA());
    expect(mine.result).toBe('READY');
    expect(
      t.metrics.count('media_duplicate_scan_truncated_total'),
    ).toBeGreaterThanOrEqual(1);
  });

  it('S29 AS-29: two simultaneous copies from two shops: both READY, exactly one suspicion, neither run fails', async () => {
    const { original, copy } = await duplicatePair({ quality: 60 });
    const slot = async (
      bytes: Buffer,
      owner: { shop: string; user: string },
    ) => {
      const created = await t.photo({
        shopId: owner.shop,
        uploaderId: owner.user,
        status: 'UPLOADED',
        uploadedAt: t.clock.now(),
      });
      await t.putOriginal(created.originalKey, bytes);
      return created;
    };
    const [a, b] = await Promise.all([
      slot(original, shopA()),
      slot(copy, shopB()),
    ]);
    const results = await Promise.all([
      t.processor().process(a.originalKey),
      t.processor().process(b.originalKey),
    ]);
    expect(results).toEqual(['READY', 'READY']);
    expect(await t.outbox('media.duplicate_suspected')).toHaveLength(1);
    const flagged = await t.sql<{ id: string }>(
      `SELECT "id" FROM "Media" WHERE "possibleDuplicateOf" IS NOT NULL`,
    );
    expect(flagged).toHaveLength(1);
  });
});
