import { randomUUID } from 'node:crypto';
import { MediaQueryService, MediaWorkerModule } from '@app/domains/media';
import {
  MINIO,
  createMediaApp,
  type MediaTestApp,
  type MediaWorld,
} from './testing/media-app';
import { MaintenanceService } from './application/maintenance.service';
import { StorageBlobs } from './infra/media-blobs';
import { photo } from './testing/test-images';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const stable = ({
  requestId,
  instance,
  traceId,
  ...rest
}: Record<string, unknown>) => {
  void requestId;
  void instance;
  void traceId;
  return rest;
};

describe('Media lifecycle and jobs', () => {
  let t: MediaTestApp;
  let w: MediaWorld;
  let jobs: MaintenanceService;

  beforeAll(async () => {
    t = await createMediaApp({ extraImports: [MediaWorkerModule] });
    jobs = t.app.get(MaintenanceService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    w = await t.world();
  });
  const ago = (ms: number) => new Date(t.clock.now().getTime() - ms);
  const remove = (user: { bearer: string; id: string }, id: string) =>
    t.as(user as never).delete(`/api/media/${id}`);

  describe('S29 US6: delete', () => {
    it.each(['READY', 'REJECTED', 'PENDING_UPLOAD', 'EXPIRED'] as const)(
      'S29 AS-47: a %s photo outside a gallery is deleted softly: history, one media.deleted, hidden from everyone',
      async (status) => {
        const created =
          status === 'READY'
            ? await t.readyPhoto(w.shop.id, w.staff.id)
            : await t.photo({
                shopId: w.shop.id,
                uploaderId: w.staff.id,
                status,
                rejectCode: status === 'REJECTED' ? 'not_an_image' : null,
              });
        const objectCalls = jest.spyOn(t.storage, 'delete');
        try {
          await remove(w.staff, created.id).expect(204);
          expect(objectCalls).not.toHaveBeenCalled(); // the request does no storage I/O
        } finally {
          objectCalls.mockRestore();
        }
        expect((await t.row(created.id))!.status).toBe('DELETED');
        expect((await t.history(created.id)).at(-1)).toMatchObject({
          fromStatus: status,
          toStatus: 'DELETED',
          actorType: 'user',
        });
        const events = await t.outbox('media.deleted');
        expect(events).toHaveLength(1);
        expect(events[0].payload).toMatchObject({
          mediaId: created.id,
          shopId: w.shop.id,
          purpose: 'product',
        });
        for (const reader of [t.as(w.staff), t.as(w.owner), t.as(w.buyer)])
          await reader.get(`/api/media/${created.id}`).expect(404);
        await t.http().get(`/api/media/${created.id}`).expect(404);
        expect(
          (await t.app.get(MediaQueryService).getReadyMediaByIds([created.id]))
            .size,
        ).toBe(0);
        await remove(w.staff, created.id).expect(404); // a second delete is the hidden 404
        expect(await t.outbox('media.deleted')).toHaveLength(1);
      },
    );

    it('S29 AS-47: a colleague with products.write and the uploader of a review photo may delete; a stranger may not', async () => {
      const shopPhoto = await t.readyPhoto(w.shop.id, w.staff.id);
      await remove(w.owner, shopPhoto.id).expect(204);
      const review = await t.photo({
        shopId: null,
        uploaderId: w.buyer.id,
        status: 'READY',
        purpose: 'review',
      });
      const missing = await remove(w.owner, review.id).expect(404);
      expect(missing.body.code).toBe('media_not_found');
      await remove(w.buyer, review.id).expect(204);
    });

    it('S29 AS-48: a photo in a gallery is 409 media_in_use naming the caller shop products; unfinished work is media_busy; a viewer is 403; no session 401', async () => {
      const product = await t.product(w.shop.id);
      const inGallery = await t.readyPhoto(w.shop.id, w.staff.id);
      await t
        .as(w.staff)
        .put(`/api/shops/${w.shop.id}/products/${product.id}/gallery`)
        .send({ mediaIds: [inGallery.id], expectedVersion: 0 })
        .expect(200);
      const refused = await remove(w.staff, inGallery.id).expect(409);
      expect(refused.body).toMatchObject({
        code: 'media_in_use',
        productIds: [product.id],
      });
      expect((await t.row(inGallery.id))!.status).toBe('READY');
      expect(await t.outbox('media.deleted')).toHaveLength(0);

      for (const status of ['UPLOADED', 'PROCESSING'] as const) {
        const busy = await t.photo({
          shopId: w.shop.id,
          uploaderId: w.staff.id,
          status,
        });
        expect((await remove(w.staff, busy.id).expect(409)).body.code).toBe(
          'media_busy',
        );
      }
      const viewerTarget = await t.readyPhoto(w.shop.id, w.staff.id);
      expect(
        (await remove(w.viewer, viewerTarget.id).expect(403)).body.code,
      ).toBe('permission_denied');
      await t.http().delete(`/api/media/${viewerTarget.id}`).expect(401);
      expect((await t.row(viewerTarget.id))!.status).toBe('READY');
    });

    it('S29 AS-48: a delete racing a gallery write cannot delete an attached photo', async () => {
      const product = await t.product(w.shop.id);
      const photoRow = await t.readyPhoto(w.shop.id, w.staff.id);
      const [del, put] = await Promise.all([
        remove(w.staff, photoRow.id),
        t
          .as(w.staff)
          .put(`/api/shops/${w.shop.id}/products/${product.id}/gallery`)
          .send({ mediaIds: [photoRow.id], expectedVersion: 0 }),
      ]);
      const attached =
        (
          await t.sql<{ n: string }>(
            `SELECT count(*) AS n FROM "ProductMedia" WHERE "mediaId" = :id`,
            { id: photoRow.id },
          )
        )[0].n === '1';
      const deleted = (await t.row(photoRow.id))!.status === 'DELETED';
      expect(attached && deleted).toBe(false); // never both
      expect([del.status, put.status].sort()).toEqual(
        attached
          ? [204 === del.status ? 0 : 409, 200].sort()
          : [204, 422].sort(),
      );
    });
  });

  describe('S29 US6: late events and the cross-tenant matrix', () => {
    it.each(['REJECTED', 'EXPIRED', 'DELETED'] as const)(
      'S29 AS-50: a late notification for a %s photo is SKIPPED and changes nothing',
      async (status) => {
        const created = await t.photo({
          shopId: w.shop.id,
          uploaderId: w.staff.id,
          status,
          rejectCode: status === 'REJECTED' ? 'not_an_image' : null,
        });
        await t.putOriginal(
          created.originalKey,
          await photo({ width: 100, height: 100 }),
        );
        const rowBefore = await t.row(created.id);
        const historyBefore = await t.history(created.id);
        const processor = t.processor();
        expect(await processor.process(created.originalKey)).toBe('SKIPPED');
        expect(await processor.process(created.originalKey)).toBe('SKIPPED');
        expect(await t.row(created.id)).toEqual(rowBefore);
        expect(await t.history(created.id)).toEqual(historyBefore);
        expect(await t.objectExists(created.originalKey)).toBe(true);
      },
    );

    it('S29 AS-50: a second upload to a used key after READY changes nothing that is served', async () => {
      const created = await t.photo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status: 'UPLOADED',
        uploadedAt: t.clock.now(),
      });
      await t.putOriginal(
        created.originalKey,
        await photo({ width: 640, height: 480, seed: 11 }),
      );
      expect(await t.processor().process(created.originalKey)).toBe('READY');
      const served = (await t.row(created.id))!.variants;
      await t.putOriginal(
        created.originalKey,
        await photo({ width: 640, height: 480, seed: 12 }),
      ); // the signed key is still usable
      expect(await t.processor().process(created.originalKey)).toBe('SKIPPED');
      expect((await t.row(created.id))!.variants).toEqual(served);
    });

    it('S29 AS-54: another user and another shop member get the identical 404 on every route, and nothing changes', async () => {
      const product = await t.product(w.shop.id);
      const otherProduct = await t.product(w.otherShop.id);
      const states = [
        'PENDING_UPLOAD',
        'UPLOADED',
        'PROCESSING',
        'REJECTED',
        'EXPIRED',
      ] as const;
      const review = await t.photo({
        shopId: null,
        uploaderId: w.buyer.id,
        status: 'PENDING_UPLOAD',
        purpose: 'review',
      });
      const shopPhotos = await Promise.all(
        states.map((status) =>
          t.photo({
            shopId: w.shop.id,
            uploaderId: w.staff.id,
            status,
            rejectCode: status === 'REJECTED' ? 'not_an_image' : null,
          }),
        ),
      );
      const ready = await t.readyPhoto(w.shop.id, w.staff.id);
      const unknown = await t
        .http()
        .get(`/api/media/${randomUUID()}`)
        .expect(404);

      for (const attacker of [w.otherOwner, w.buyer]) {
        for (const target of [review, ...shopPhotos]) {
          if (attacker === w.buyer && target === review) continue; // the buyer owns the review photo
          for (const res of [
            await t.as(attacker).post(`/api/media/${target.id}/complete`),
            await t.as(attacker).delete(`/api/media/${target.id}`),
            await t.as(attacker).get(`/api/media/${target.id}`),
          ]) {
            expect(res.status).toBe(404);
            expect(stable(res.body)).toEqual(stable(unknown.body));
          }
        }
      }
      // attaching A's photo to B's product, and B's own product with A's photo, both fail as `not_found`
      const attach = await t
        .as(w.otherOwner)
        .put(`/api/shops/${w.otherShop.id}/products/${otherProduct.id}/gallery`)
        .send({ mediaIds: [ready.id], expectedVersion: 0 })
        .expect(422);
      expect(attach.body.failures).toEqual([
        { mediaId: ready.id, code: 'not_found' },
      ]);
      const ownProduct = await t
        .as(w.otherOwner)
        .put(`/api/shops/${w.shop.id}/products/${product.id}/gallery`)
        .send({ mediaIds: [], expectedVersion: 0 })
        .expect(404);
      expect(ownProduct.body.code).toBe('shop_not_found');
      for (const target of [review, ...shopPhotos])
        expect((await t.row(target.id))!.status).not.toBe('DELETED');
      expect(await t.outbox('media.deleted')).toHaveLength(0);
      expect(t.queue.sent).toHaveLength(0);
    });
  });

  describe('S29 US6: jobs', () => {
    it('S29 AS-51: slots older than 60 minutes expire with their object; younger ones and a rerun are untouched; two instances expire a slot once', async () => {
      const old = await t.photo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        createdAt: ago(61 * MINUTE),
      });
      const fresh = await t.photo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        createdAt: ago(59 * MINUTE),
      });
      await t.putOriginal(old.originalKey, Buffer.from('half an upload'));
      const counts = await Promise.all([
        jobs.expirePendingUploads(),
        jobs.expirePendingUploads(),
      ]);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
      expect(await t.row(old.id)).toMatchObject({ status: 'EXPIRED' });
      expect((await t.history(old.id)).at(-1)).toMatchObject({
        fromStatus: 'PENDING_UPLOAD',
        toStatus: 'EXPIRED',
        actorType: 'system',
      });
      expect(
        (await t.history(old.id)).filter((h) => h.toStatus === 'EXPIRED'),
      ).toHaveLength(1);
      expect(await t.objectExists(old.originalKey)).toBe(false);
      expect((await t.row(fresh.id))!.status).toBe('PENDING_UPLOAD');
      expect(await jobs.expirePendingUploads()).toBe(0);
      // the expired slot now answers upload_expired
      expect(
        (await t.as(w.staff).post(`/api/media/${old.id}/complete`).expect(409))
          .body.code,
      ).toBe('upload_expired');
    });

    it('S29 AS-52: lost messages and dead workers are re-sent once, at most 100 per run, never again within the minute', async () => {
      const lost = await t.photo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status: 'UPLOADED',
        uploadedAt: ago(3 * MINUTE),
        createdAt: ago(3 * MINUTE),
      });
      const young = await t.photo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status: 'UPLOADED',
        uploadedAt: ago(1 * MINUTE),
        createdAt: ago(1 * MINUTE),
      });
      const dead = await t.photo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status: 'PROCESSING',
        attempts: 1,
        leaseUntil: ago(10 * MINUTE),
        createdAt: ago(20 * MINUTE),
      });
      const held = await t.photo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status: 'PROCESSING',
        attempts: 1,
        leaseUntil: new Date(t.clock.now().getTime() + 3 * MINUTE),
        createdAt: ago(20 * MINUTE),
      });
      expect(await jobs.requeueStuck()).toBe(2);
      const sent = t.queue.sent.filter((m) => m.queue === 'media-processing');
      expect(
        sent.map((m) => (m.body as { mediaId: string }).mediaId).sort(),
      ).toEqual([lost.id, dead.id].sort());
      for (const m of sent) {
        expect(m.options?.groupId).toBeUndefined(); // a standard queue never gets FIFO options (L-001)
        expect(Object.keys(m.body as object).sort()).toEqual([
          'mediaId',
          'originalKey',
        ]);
      }
      expect(
        [young.id, held.id].every(
          (id) =>
            !sent.some((m) => (m.body as { mediaId: string }).mediaId === id),
        ),
      ).toBe(true);
      expect(await jobs.requeueStuck()).toBe(0);
      expect(t.queue.sent).toHaveLength(2);
    });

    it('S29 AS-52: the re-drive job sends at most 100 messages per run', async () => {
      for (let i = 0; i < 101; i++)
        await t.photo({
          shopId: w.shop.id,
          uploaderId: w.staff.id,
          status: 'UPLOADED',
          uploadedAt: ago(5 * MINUTE),
          createdAt: ago(5 * MINUTE),
        });
      expect(await jobs.requeueStuck()).toBe(100);
      expect(t.queue.sent).toHaveLength(100);
    });

    const aged = async (
      status: 'REJECTED' | 'EXPIRED' | 'DELETED',
      age: number,
      variants?: Record<string, { key: string; width: number; height: number }>,
    ) =>
      t.photo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status,
        rejectCode: status === 'REJECTED' ? 'not_an_image' : null,
        variants: (variants as never) ?? null,
        createdAt: ago(age + DAY),
        updatedAt: ago(age),
      });
    const variantsAt = (prefix: string) =>
      Object.fromEntries(
        ['thumb', 'feed', 'full'].map((name) => [
          name,
          {
            key: `media/derived/${prefix}-${name}.webp`,
            width: 10,
            height: 10,
          },
        ]),
      );

    it('S29 AS-53: terminal rows older than 7 days go with their originals and unshared variants; shared variants and younger rows stay; reruns change nothing', async () => {
      const tag = randomUUID().replace(/-/g, '');
      const shared = variantsAt(`${tag}-shared`);
      const lonely = variantsAt(`${tag}-lonely`);
      const old = [
        await aged('REJECTED', 8 * DAY),
        await aged('EXPIRED', 8 * DAY),
        await aged('DELETED', 8 * DAY, shared as never),
      ];
      const oldLonely = await aged('DELETED', 8 * DAY, lonely as never);
      const young = [
        await aged('REJECTED', 6 * DAY),
        await aged('EXPIRED', 6 * DAY),
        await aged('DELETED', 6 * DAY),
      ];
      const live = await t.readyPhoto(w.shop.id, w.staff.id);
      await t.sql(
        `UPDATE "Media" SET "variants" = :variants::jsonb WHERE "id" = :id`,
        { id: live.id, variants: JSON.stringify(shared) },
      );
      for (const key of [
        ...Object.values(shared),
        ...Object.values(lonely),
      ].map((v) => (v as { key: string }).key))
        await t.putOriginal(key, Buffer.from(key), 'image/webp');
      for (const p of [...old, oldLonely, ...young])
        await t.putOriginal(p.originalKey, Buffer.from('original'));

      expect(await jobs.purge()).toBe(4);

      for (const p of [...old, oldLonely]) {
        expect(await t.row(p.id)).toBeUndefined();
        expect(await t.history(p.id)).toEqual([]);
        expect(await t.objectExists(p.originalKey)).toBe(false);
      }
      for (const p of young) {
        expect(await t.row(p.id)).toBeDefined();
        expect(await t.objectExists(p.originalKey)).toBe(true);
      }
      for (const v of Object.values(lonely))
        expect(await t.objectExists((v as { key: string }).key)).toBe(false);
      for (const v of Object.values(shared))
        expect(await t.objectExists((v as { key: string }).key)).toBe(true); // a live photo still uses them
      expect((await t.row(live.id))!.status).toBe('READY');

      expect(await jobs.purge()).toBe(0);
    });

    it('S29 AS-53: at most 200 rows per run', async () => {
      await t.sql(
        `INSERT INTO "Media" ("shopId","uploaderId","purpose","status","originalKey","rejectCode","createdAt","updatedAt")
         SELECT :shop, :user, 'product', 'EXPIRED', 'media/originals/seed/' || g, NULL, now() - interval '20 days', now() - interval '9 days'
           FROM generate_series(1, 201) g`,
        { shop: w.shop.id, user: w.staff.id },
      );
      expect(await jobs.purge()).toBe(200);
      expect(
        Number(
          (await t.sql<{ n: string }>(`SELECT count(*) AS n FROM "Media"`))[0]
            .n,
        ),
      ).toBe(1);
      expect(await jobs.purge()).toBe(1);
    });

    it('S29 AS-53: one delete that fails leaves its row for the next run and does not stop the others', async () => {
      const rows = [
        await aged('EXPIRED', 8 * DAY),
        await aged('EXPIRED', 8 * DAY),
        await aged('EXPIRED', 8 * DAY),
      ];
      for (const p of rows)
        await t.putOriginal(p.originalKey, Buffer.from('original'));
      const proxy = await t.faultProxy(MINIO);
      const viaProxy = new StorageBlobs(
        t.storageVia(`http://127.0.0.1:${proxy.port}`),
      ); // same bucket through the faulty network
      void viaProxy;
      const real = t.storageVia(`http://127.0.0.1:${proxy.port}`);
      const doomed = rows[1].originalKey;
      class Flaky extends ObjectStorage {
        presignPost = real.presignPost.bind(real);
        presignGet = real.presignGet.bind(real);
        presignPutChecked = real.presignPutChecked.bind(real);
        createMultipartUpload = real.createMultipartUpload.bind(real);
        completeMultipartUpload = real.completeMultipartUpload.bind(real);
        abortMultipartUpload = real.abortMultipartUpload.bind(real);
        startMultipartUpload = real.startMultipartUpload.bind(real);
        presignUploadPart = real.presignUploadPart.bind(real);
        listParts = real.listParts.bind(real);
        deletePrefix = real.deletePrefix.bind(real);
        getStream = real.getStream.bind(real);
        put = real.put.bind(real);
        head = real.head.bind(real);
        list = real.list.bind(real);
        async delete(key: string) {
          if (key === doomed) proxy.mode = 'refuse'; // the network breaks exactly for this delete
          try {
            await real.delete(key);
          } finally {
            proxy.mode = 'pass';
          }
        }
      }
      const flaky = new MaintenanceService(
        t.store,
        new Flaky(),
        t.queue,
        t.clock,
      );
      expect(await flaky.purge()).toBe(2);
      expect(await t.row(rows[1].id)).toBeDefined();
      expect(await t.objectExists(doomed)).toBe(true);
      expect(await t.row(rows[0].id)).toBeUndefined();
      expect(await t.row(rows[2].id)).toBeUndefined();
      expect(await jobs.purge()).toBe(1); // the next run finishes it
      expect(await t.row(rows[1].id)).toBeUndefined();
      expect(await t.objectExists(doomed)).toBe(false);
    });
  });
});
