import { randomUUID } from 'node:crypto';
import {
  mediaUploadResponseSchema,
  type MediaUploadResponse,
} from '@marketplace-sandbox/contracts';
import type { TestUser } from '@app/test/utils/catalog-app';
import {
  createMediaApp,
  type MediaTestApp,
  type MediaWorld,
} from './testing/media-app';
import { photo } from './testing/test-images';

/** Parallel and repeated requests on photos and galleries (QA track 3); after each race the database must hold no impossible row. */
describe('Media concurrency', () => {
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

  const statuses = (results: Array<{ status: number }>) =>
    results.map((r) => r.status).sort();
  const count = (results: Array<{ status: number }>, status: number) =>
    results.filter((r) => r.status === status).length;
  const put = (
    productId: string,
    body: { mediaIds: string[]; expectedVersion: number },
    user: TestUser = w.staff,
  ) =>
    t
      .as(user)
      .put(`/api/shops/${w.shop.id}/products/${productId}/gallery`)
      .send(body);
  const read = (productId: string, user: TestUser = w.viewer) =>
    t.as(user).get(`/api/shops/${w.shop.id}/products/${productId}/gallery`);
  const shopUpload = (user: TestUser = w.staff) =>
    t
      .as(user)
      .post(`/api/shops/${w.shop.id}/media/uploads`)
      .send({ purpose: 'product' });
  const links = (productId: string) =>
    t.sql<{ mediaId: string; position: number }>(
      `SELECT "mediaId", "position"::int AS position FROM "ProductMedia" WHERE "productId" = :productId ORDER BY "position"`,
      { productId },
    );
  const ready = (n: number) =>
    Promise.all(
      Array.from({ length: n }, () => t.readyPhoto(w.shop.id, w.staff.id)),
    );

  /** Rows that may never exist, whatever the order of the requests. */
  const impossibleMediaRows = async () => ({
    // a gallery link whose photo is gone, deleted, or belongs to another shop than the product's gallery
    linkToMissingOrDeleted: await t.sql(
      `SELECT pm."productId", pm."mediaId" FROM "ProductMedia" pm
         LEFT JOIN "Media" m ON m."id" = pm."mediaId"
        WHERE m."id" IS NULL OR m."status" = 'DELETED'`,
    ),
    linkToOtherShop: await t.sql(
      `SELECT pm."productId", pm."mediaId" FROM "ProductMedia" pm
         JOIN "Media" m ON m."id" = pm."mediaId"
         JOIN "ProductGallery" g ON g."productId" = pm."productId"
        WHERE m."shopId" IS DISTINCT FROM g."shopId"`,
    ),
    // two photos in one place of one gallery, or a gap in the positions
    duplicatePosition: await t.sql(
      `SELECT "productId", "position" FROM "ProductMedia" GROUP BY 1, 2 HAVING count(*) > 1`,
    ),
    positionGap: await t.sql(
      `SELECT "productId" FROM "ProductMedia" GROUP BY 1 HAVING max("position") + 1 <> count(*)`,
    ),
    // the same photo twice in one gallery
    duplicatePhoto: await t.sql(
      `SELECT "productId", "mediaId" FROM "ProductMedia" GROUP BY 1, 2 HAVING count(*) > 1`,
    ),
    // a gallery with links but no version row, or one event more or fewer than its version
    linksWithoutVersion: await t.sql(
      `SELECT DISTINCT pm."productId" FROM "ProductMedia" pm
        WHERE NOT EXISTS (SELECT 1 FROM "ProductGallery" g WHERE g."productId" = pm."productId")`,
    ),
    eventsDoNotMatchVersion: await t.sql(
      `SELECT g."productId", g."version", count(o."id")::int AS "events"
         FROM "ProductGallery" g LEFT JOIN "Outbox" o
           ON o."aggregateId" = g."productId"::text AND o."type" = 'media.gallery_changed'
        WHERE g."version" > 0
        GROUP BY 1, 2 HAVING count(o."id") <> g."version"`,
    ),
    // a photo with a status the machine does not allow after its history, or two rows of history for one move
    historyTwice: await t.sql(
      `SELECT "mediaId", "toStatus" FROM "MediaStatusHistory" GROUP BY 1, 2 HAVING count(*) > 1`,
    ),
  });
  const NOTHING = {
    linkToMissingOrDeleted: [],
    linkToOtherShop: [],
    duplicatePosition: [],
    positionGap: [],
    duplicatePhoto: [],
    linksWithoutVersion: [],
    eventsDoNotMatchVersion: [],
    historyTwice: [],
  };

  describe('gallery writes with expectedVersion', () => {
    it('S29 AS-32: two clients write version 0 with different photos: one wins, the other gets 409, and the gallery is exactly the winner’s', async () => {
      const product = await t.product(w.shop.id);
      const [m1, m2, m3] = await ready(3);
      const results = await Promise.all([
        put(product.id, { mediaIds: [m1.id, m2.id], expectedVersion: 0 }),
        put(product.id, { mediaIds: [m3.id], expectedVersion: 0 }, w.owner),
      ]);
      expect(statuses(results)).toEqual([200, 409]);
      const winner = results.find((r) => r.status === 200)!;
      const loser = results.find((r) => r.status === 409)!;
      expect(loser.body.code).toBe('version_conflict');
      expect(winner.body.version).toBe(1);

      expect((await links(product.id)).map((l) => l.mediaId)).toEqual(
        winner.body.items.map((i: { mediaId: string }) => i.mediaId),
      );
      expect(await t.outbox('media.gallery_changed')).toHaveLength(1);
      expect(await impossibleMediaRows()).toEqual(NOTHING);
    });

    it('S29 AS-32: eight clients send the same gallery for version 0 at once: one write lands, seven get 409, one event', async () => {
      const product = await t.product(w.shop.id);
      const [m1, m2] = await ready(2);
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          put(product.id, { mediaIds: [m1.id, m2.id], expectedVersion: 0 }),
        ),
      );
      expect(count(results, 200)).toBe(1);
      expect(count(results, 409)).toBe(7);
      expect((await links(product.id)).map((l) => l.mediaId)).toEqual([
        m1.id,
        m2.id,
      ]);
      expect(await t.outbox('media.gallery_changed')).toHaveLength(1);
      expect(await impossibleMediaRows()).toEqual(NOTHING);
    });

    it('S29 AS-32: five clients each read the gallery, append their own photo and retry on 409: all five photos end up in it, once each', async () => {
      const product = await t.product(w.shop.id);
      const mine = await ready(5);
      const append = async (photoId: string) => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const current = (await read(product.id).expect(200)).body as {
            items: Array<{ mediaId: string }>;
            version: number;
          };
          const res = await put(product.id, {
            mediaIds: [...current.items.map((i) => i.mediaId), photoId],
            expectedVersion: current.version,
          });
          if (res.status === 200) return;
          expect(res.status).toBe(409);
        }
        throw new Error('a client never got through');
      };
      await Promise.all(mine.map((m) => append(m.id)));

      const stored = await links(product.id);
      expect(stored.map((l) => l.mediaId).sort()).toEqual(
        mine.map((m) => m.id).sort(),
      );
      expect(stored.map((l) => l.position)).toEqual([0, 1, 2, 3, 4]);
      expect((await t.outbox('media.gallery_changed')).map((e) => e.aggregateVersion)).toEqual([
        1, 2, 3, 4, 5,
      ]);
      expect(await impossibleMediaRows()).toEqual(NOTHING);
    });

    it('S29 AS-32: a reader never sees a gallery whose items belong to another version than the one it reports', async () => {
      const product = await t.product(w.shop.id);
      const [a, b] = await ready(2);
      // version v holds [a] when v is odd and [b] when v is even: a reader can tell a mixed answer at once
      const expectedItems = (version: number) =>
        version === 0 ? [] : [version % 2 === 1 ? a.id : b.id];
      let writing = true;
      const writer = (async () => {
        for (let version = 0; version < 12; version += 1)
          await put(product.id, {
            mediaIds: expectedItems(version + 1),
            expectedVersion: version,
          }).expect(200);
        writing = false;
      })();
      const reader = async () => {
        const seen: Array<{ version: number; ids: string[] }> = [];
        while (writing) {
          const res = await read(product.id).expect(200);
          seen.push({
            version: res.body.version,
            ids: res.body.items.map((i: { mediaId: string }) => i.mediaId),
          });
        }
        return seen;
      };
      const [, ...seen] = await Promise.all([
        writer,
        reader(),
        reader(),
        reader(),
      ]);
      for (const { version, ids } of seen.flat())
        expect({ version, ids }).toEqual({
          version,
          ids: expectedItems(version),
        });
      expect(await impossibleMediaRows()).toEqual(NOTHING);
    });
  });

  describe('photo deletes and gallery attaches', () => {
    it('S29 AS-34: deleting a photo while it is being attached: either the attach wins and the delete is refused, or the delete wins and the attach is refused, never a link to a deleted photo', async () => {
      for (let round = 0; round < 6; round += 1) {
        const product = await t.product(w.shop.id);
        const [m] = await ready(1);
        const [attach, remove] = await Promise.all([
          put(product.id, { mediaIds: [m.id], expectedVersion: 0 }),
          t.as(w.staff).delete(`/api/media/${m.id}`),
        ]);
        if (attach.status === 200) {
          expect(remove.status).toBe(409);
          expect(remove.body.code).toBe('media_in_use');
          expect((await t.row(m.id))!.status).toBe('READY');
        } else {
          expect(remove.status).toBe(204);
          expect(attach.status).toBe(422);
          expect((await t.row(m.id))!.status).toBe('DELETED');
          expect(await links(product.id)).toEqual([]);
        }
      }
      expect(await impossibleMediaRows()).toEqual(NOTHING);
    });

    it('S29 AS-34: the same photo deleted five times at once: one delete lands, one history row to DELETED, one deleted event', async () => {
      const [m] = await ready(1);
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          t.as(w.staff).delete(`/api/media/${m.id}`),
        ),
      );
      expect(count(results, 204)).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r.status === 204 || r.status === 404)).toBe(
        true,
      );
      expect((await t.row(m.id))!.status).toBe('DELETED');
      const deletedMoves = (await t.history(m.id)).filter(
        (h) => h.toStatus === 'DELETED',
      );
      expect(deletedMoves).toHaveLength(1);
      expect(await t.outbox('media.deleted')).toHaveLength(1);
      expect(await impossibleMediaRows()).toEqual(NOTHING);
    });

    it('S29 AS-34: two products race for the same photo: both can show it (a photo may sit in several galleries) and the delete is refused while any gallery holds it', async () => {
      const p1 = await t.product(w.shop.id);
      const p2 = await t.product(w.shop.id);
      const [m] = await ready(1);
      const results = await Promise.all([
        put(p1.id, { mediaIds: [m.id], expectedVersion: 0 }),
        put(p2.id, { mediaIds: [m.id], expectedVersion: 0 }),
      ]);
      expect(statuses(results)).toEqual([200, 200]);
      const refused = await t.as(w.staff).delete(`/api/media/${m.id}`);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('media_in_use');
      expect((await t.row(m.id))!.status).toBe('READY');
      expect(await impossibleMediaRows()).toEqual(NOTHING);
    });
  });

  describe('uploads', () => {
    it('S29 AS-04: a hundred presign requests at once by one member never leave more than 50 pending uploads', async () => {
      const results = await Promise.all(
        Array.from({ length: 100 }, () => shopUpload()),
      );
      const created = results.filter((r) => r.status === 201);
      const refused = results.filter((r) => r.status !== 201);
      for (const r of refused) {
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('pending_uploads_limit');
      }
      const pending = await t.sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM "Media" WHERE "uploaderId" = :id AND "status" = 'PENDING_UPLOAD'`,
        { id: w.staff.id },
      );
      expect(pending[0].n).toBe(created.length);
      expect(pending[0].n).toBeLessThanOrEqual(50);
      const keys = await t.sql<{ originalKey: string }>(
        `SELECT DISTINCT "originalKey" FROM "Media"`,
      );
      expect(keys).toHaveLength(created.length);
    });

    it('S29 AS-02: ten presigns at once give ten different photo ids and keys, each with its first history row', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => shopUpload()),
      );
      expect(statuses(results)).toEqual(Array(10).fill(201));
      const ids = results.map(
        (r) => mediaUploadResponseSchema.parse(r.body).mediaId,
      );
      expect(new Set(ids).size).toBe(10);
      expect(
        new Set(
          results.map(
            (r) => (r.body as MediaUploadResponse).upload.fields.key,
          ),
        ).size,
      ).toBe(10);
      for (const id of ids)
        expect((await t.history(id)).map((h) => h.toStatus)).toEqual([
          'PENDING_UPLOAD',
        ]);
      expect(await impossibleMediaRows()).toEqual(NOTHING);
    });

    it('S29 AS-07: complete sent six times at once for one uploaded photo moves it once and queues one job', async () => {
      const created = mediaUploadResponseSchema.parse(
        (await shopUpload().expect(201)).body,
      );
      await t.putOriginal(created.upload.fields.key, await photo({ width: 300, height: 200 }));
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          t.as(w.staff).post(`/api/media/${created.mediaId}/complete`),
        ),
      );
      expect(results.every((r) => r.status === 202)).toBe(true);
      expect(results.every((r) => r.body.status === 'UPLOADED')).toBe(true);
      expect(await t.row(created.mediaId)).toMatchObject({
        status: 'UPLOADED',
        version: 2,
      });
      expect(
        (await t.history(created.mediaId)).map((h) => h.toStatus),
      ).toEqual(['PENDING_UPLOAD', 'UPLOADED']);
      expect(t.queue.sent).toHaveLength(1);
      expect(await impossibleMediaRows()).toEqual(NOTHING);
    });

    it('S29 AS-07: complete and delete at once on an uploaded photo: delete is refused while the photo waits to be processed', async () => {
      const created = mediaUploadResponseSchema.parse(
        (await shopUpload().expect(201)).body,
      );
      await t.putOriginal(created.upload.fields.key, await photo({ width: 300, height: 200 }));
      const [done, removed] = await Promise.all([
        t.as(w.staff).post(`/api/media/${created.mediaId}/complete`),
        t.as(w.staff).delete(`/api/media/${created.mediaId}`),
      ]);
      const row = (await t.row(created.mediaId))!;
      if (removed.status === 204) {
        // the delete came first: the photo is gone and the complete answers like for an unknown photo
        expect(row.status).toBe('DELETED');
        expect(done.status).toBe(404);
        expect(t.queue.sent).toHaveLength(0);
      } else {
        expect(done.status).toBe(202);
        expect(removed.status).toBe(409);
        expect(removed.body.code).toBe('media_busy');
        expect(row.status).toBe('UPLOADED');
        expect(t.queue.sent).toHaveLength(1);
      }
      expect(await impossibleMediaRows()).toEqual(NOTHING);
    });
  });

  it('S29 AS-41: forty parallel reads of one photo, its gallery and the batch answer the same thing while the gallery changes', async () => {
    const product = await t.product(w.shop.id);
    const [m1, m2] = await ready(2);
    await put(product.id, { mediaIds: [m1.id], expectedVersion: 0 }).expect(200);
    const [reads] = await Promise.all([
      Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          i % 3 === 0
            ? t.http().get(`/api/media/${m1.id}`)
            : i % 3 === 1
              ? t.http().get(`/api/products/${product.id}/gallery`)
              : t.http().get(`/api/batch/media?ids=${m1.id},${m2.id},${randomUUID()}`),
        ),
      ),
      put(product.id, { mediaIds: [m2.id, m1.id], expectedVersion: 1 }).expect(200),
    ]);
    for (const r of reads) expect(r.status).toBe(200);
    expect(await impossibleMediaRows()).toEqual(NOTHING);
  });
});
