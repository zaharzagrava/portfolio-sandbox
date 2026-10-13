import { randomUUID } from 'node:crypto';
import {
  mediaCompleteResponseSchema,
  mediaUploadResponseSchema,
  type MediaUploadResponse,
} from '@marketplace-sandbox/contracts';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import type { TestUser } from '@app/test/utils/catalog-app';
import {
  MINIO,
  createMediaApp,
  type MediaTestApp,
  type MediaWorld,
} from './testing/media-app';
import { manyBytes, photo } from './testing/test-images';

const UUID_V = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** The part of a problem document that does not vary between two equal answers. */
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

describe('Media upload API', () => {
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

  const shopUpload = (
    user: TestUser,
    shopId: string,
    body: unknown = { purpose: 'product' },
  ) =>
    t
      .as(user)
      .post(`/api/shops/${shopId}/media/uploads`)
      .send(body as object);
  const reviewUpload = (
    user: TestUser,
    body: unknown = { purpose: 'review' },
  ) =>
    t
      .as(user)
      .post('/api/media/uploads')
      .send(body as object);
  const count = async (where = 'TRUE') =>
    Number(
      (
        await t.sql<{ n: string }>(
          `SELECT count(*) AS n FROM "Media" WHERE ${where}`,
        )
      )[0].n,
    );

  /** Posts the form exactly as a browser would, to the storage address the API gave. */
  const post = async (
    upload: MediaUploadResponse['upload'],
    body: Buffer,
    contentType = 'image/jpeg',
    override: Record<string, string> = {},
  ) => {
    const form = new FormData();
    for (const [name, value] of Object.entries({
      ...upload.fields,
      ...override,
    }))
      form.append(name, value);
    form.append('Content-Type', contentType);
    form.append(
      'file',
      new Blob([new Uint8Array(body)], { type: contentType }),
      'upload',
    );
    return fetch(upload.url, { method: 'POST', body: form });
  };

  describe('S29 US1: presign', () => {
    it('S29 AS-01: a shop member gets a signed permission bound to a server-chosen key', async () => {
      const res = await shopUpload(w.staff, w.shop.id).expect(201);
      const body = mediaUploadResponseSchema.parse(res.body);
      expect(Buffer.byteLength(JSON.stringify(res.body))).toBeLessThanOrEqual(
        4096,
      );
      expect(res.body).not.toHaveProperty('key');
      expect(body.maxBytes).toBe(15_728_640);
      expect(body.allowedContentTypes).toEqual([
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/avif',
      ]);

      const row = await t.row(body.mediaId);
      expect(row).toMatchObject({
        status: 'PENDING_UPLOAD',
        purpose: 'product',
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        attempts: 0,
        version: 1,
      });
      expect(row!.originalKey).toMatch(
        new RegExp(`^media/originals/shops/${w.shop.id}/${UUID_V}$`),
      );
      expect(body.upload.fields.key).toBe(row!.originalKey);
      expect(
        Object.values(body.upload.fields).filter((v) => v.startsWith('media/')),
      ).toEqual([row!.originalKey]);

      expect(await t.history(body.mediaId)).toEqual([
        {
          fromStatus: null,
          toStatus: 'PENDING_UPLOAD',
          actorType: 'user',
          rejectCode: null,
        },
      ]);
      expect(new Date(body.upload.expiresAt).getTime()).toBe(
        t.clock.now().getTime() + 600_000,
      );

      const policy = JSON.parse(
        Buffer.from(
          body.upload.fields.Policy ?? body.upload.fields.policy,
          'base64',
        ).toString(),
      );
      expect(policy.conditions).toEqual(
        expect.arrayContaining([
          ['content-length-range', 1, 15_728_640],
          ['starts-with', '$Content-Type', 'image/'],
          { key: row!.originalKey },
        ]),
      );
      const expires = new Date(policy.expiration).getTime();
      expect(expires).toBeGreaterThan(Date.now());
      expect(expires).toBeLessThanOrEqual(Date.now() + 601_000);
    });

    it('S29 AS-02: a signed-in user gets a review upload under users/<id>; every other purpose is refused', async () => {
      const res = await reviewUpload(w.buyer).expect(201);
      const body = mediaUploadResponseSchema.parse(res.body);
      const row = await t.row(body.mediaId);
      expect(row).toMatchObject({
        purpose: 'review',
        shopId: null,
        uploaderId: w.buyer.id,
      });
      expect(row!.originalKey).toMatch(
        new RegExp(`^media/originals/users/${w.buyer.id}/${UUID_V}$`),
      );

      const before = await count();
      for (const bad of [
        { purpose: 'product' },
        { purpose: 'post' },
        { purpose: 'avatar' },
        {},
      ]) {
        const refused = await reviewUpload(w.buyer, bad).expect(400);
        expect(refused.body.code).toBe('validation_failed');
      }
      expect(await count()).toBe(before);
    });

    it.each([
      ['no purpose', {}],
      ['the review purpose on the shop route', { purpose: 'review' }],
      ['the removed post purpose', { purpose: 'post' }],
      ['a client-chosen key', { purpose: 'product', key: 'media/originals/x' }],
      ['a shopId in the body', { purpose: 'product', shopId: randomUUID() }],
      ['a mediaId in the body', { purpose: 'product', mediaId: randomUUID() }],
      ['a content type', { purpose: 'product', contentType: 'image/png' }],
      ['a size', { purpose: 'product', maxBytes: 1 }],
    ])(
      'S29 AS-03: the shop route refuses %s and persists nothing',
      async (_name, body) => {
        const res = await shopUpload(w.owner, w.shop.id, body).expect(400);
        expect(res.body.code).toBe('validation_failed');
        expect(await count()).toBe(0);
      },
    );

    it('S29 AS-03: 401 without credentials, 403 for a viewer, the same 404 for a stranger and an unknown shop', async () => {
      await t
        .http()
        .post(`/api/shops/${w.shop.id}/media/uploads`)
        .send({ purpose: 'product' })
        .expect(401);
      await t
        .http()
        .post('/api/media/uploads')
        .send({ purpose: 'review' })
        .expect(401);
      const viewer = await shopUpload(w.viewer, w.shop.id).expect(403);
      expect(viewer.body.code).toBe('permission_denied');
      const stranger = await shopUpload(w.buyer, w.shop.id).expect(404);
      const unknown = await shopUpload(w.buyer, randomUUID()).expect(404);
      expect(stable(stranger.body)).toEqual(stable(unknown.body));
      expect(await count()).toBe(0);
    });

    it('S29 AS-03: a suspended shop is 403 shop_suspended, one being closed is 409 shop_offboarding', async () => {
      const suspended = await createShop(t.app, w.owner, {
        status: 'SUSPENDED',
      });
      const closing = await createShop(t.app, w.owner, {
        status: 'DELETING',
        purgeAt: new Date(Date.now() + 86_400_000),
      });
      expect(
        (await shopUpload(w.owner, suspended.id).expect(403)).body.code,
      ).toBe('shop_suspended');
      expect(
        (await shopUpload(w.owner, closing.id).expect(409)).body.code,
      ).toBe('shop_offboarding');
      expect(await count()).toBe(0);
    });

    it('S29 AS-04: 50 waiting uploads per scope; the 51st is 409, freeing one lets the next through, scopes are separate', async () => {
      for (let i = 0; i < 50; i++)
        await t.photo({ shopId: w.shop.id, uploaderId: w.staff.id });
      const refused = await shopUpload(w.staff, w.shop.id).expect(409);
      expect(refused.body).toMatchObject({
        code: 'pending_uploads_limit',
        count: 50,
      });
      expect(await count()).toBe(50);

      // another uploader of the same shop, and the same user's personal scope, are unaffected
      await shopUpload(w.owner, w.shop.id).expect(201);
      await reviewUpload(w.staff).expect(201);

      const [first] = await t.sql<{ id: string }>(
        `SELECT "id" FROM "Media" WHERE "uploaderId" = :id AND "status" = 'PENDING_UPLOAD' ORDER BY "id" LIMIT 1`,
        { id: w.staff.id },
      );
      await t.as(w.staff).delete(`/api/media/${first.id}`).expect(204);
      await shopUpload(w.staff, w.shop.id).expect(201);
    });
  });

  describe('S29 US1: rate limits', () => {
    it('S29 AS-05: the 31st request of a user in a minute is 429 with Retry-After and creates no row', async () => {
      for (let i = 0; i < 30; i++) await reviewUpload(w.buyer).expect(201);
      const limited = await reviewUpload(w.buyer).expect(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(await count(`"uploaderId" = '${w.buyer.id}'`)).toBe(30);
    });

    it('S29 AS-05: the 121st request of a shop in a minute is 429, whoever the member is', async () => {
      // the pending quota is per uploader (50), so three members share the shop's 120
      const third = await t.newUser();
      await addMember(t.app, w.shop.id, third.id, 'STAFF');
      const members = [w.owner, w.staff, third];
      for (let i = 0; i < 120; i++)
        await shopUpload(members[i % 3], w.shop.id).expect(201);
      const limited = await shopUpload(w.owner, w.shop.id).expect(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(await count()).toBe(120);
    });
  });

  describe('S29 US1: the signed permission is enforced by storage', () => {
    it('S29 AS-06: a valid JPEG is stored; a wrong content type, an oversize body and another key are refused and leave no object', async () => {
      const res = await shopUpload(w.staff, w.shop.id).expect(201);
      const { upload, mediaId } = mediaUploadResponseSchema.parse(res.body);
      const key = upload.fields.key;
      expect(upload.url.startsWith(`http://${MINIO.host}:${MINIO.port}`)).toBe(
        true,
      );

      const wrongType = await post(
        upload,
        await photo({ width: 100, height: 100 }),
        'text/plain',
      );
      expect(wrongType.status).toBeGreaterThanOrEqual(400);
      expect(await t.objectExists(key)).toBe(false);

      const tooBig = await post(upload, manyBytes(15 * 1024 * 1024 + 1));
      expect(tooBig.status).toBeGreaterThanOrEqual(400);
      expect(await t.objectExists(key)).toBe(false);

      const otherKey = `media/originals/shops/${w.shop.id}/${randomUUID()}`;
      const wrongKey = await post(
        upload,
        await photo({ width: 100, height: 100 }),
        'image/jpeg',
        { key: otherKey },
      );
      expect(wrongKey.status).toBeGreaterThanOrEqual(400);
      expect(await t.objectExists(otherKey)).toBe(false);
      expect(await t.objectExists(key)).toBe(false);

      const ok = await post(upload, await photo({ width: 100, height: 100 }));
      expect(ok.status).toBeLessThan(300);
      expect(await t.objectExists(key)).toBe(true);
      expect((await t.row(mediaId))!.status).toBe('PENDING_UPLOAD'); // storage alone never moves the row
    });
  });

  describe('S29 US1: complete', () => {
    const uploadedPhoto = async (user: TestUser = w.staff) => {
      const created = mediaUploadResponseSchema.parse(
        (await shopUpload(user, w.shop.id).expect(201)).body,
      );
      const key = created.upload.fields.key;
      await t.putOriginal(key, await photo({ width: 300, height: 200 }));
      return { id: created.mediaId, key };
    };
    const complete = (user: TestUser, id: string) =>
      t.as(user).post(`/api/media/${id}/complete`);

    it('S29 AS-07: complete moves PENDING_UPLOAD to UPLOADED and sends one message after commit', async () => {
      const { id, key } = await uploadedPhoto();
      const res = await complete(w.staff, id).expect(202);
      expect(mediaCompleteResponseSchema.parse(res.body)).toEqual({
        status: 'UPLOADED',
      });
      const row = await t.row(id);
      expect(row).toMatchObject({ status: 'UPLOADED', version: 2 });
      expect(row!.uploadedAt).not.toBeNull();
      expect(
        (await t.history(id)).map((h) => `${h.fromStatus}>${h.toStatus}`),
      ).toEqual(['null>PENDING_UPLOAD', 'PENDING_UPLOAD>UPLOADED']);
      expect(t.queue.sent).toHaveLength(1);
      expect(t.queue.sent[0]).toMatchObject({
        queue: 'media-processing',
        body: { mediaId: id, originalKey: key },
      });
      expect(t.queue.sent[0].options?.groupId).toBeUndefined(); // L-001: a standard queue never gets FIFO options
    });

    it('S29 AS-07: a transaction that rolls back leaves the row and the queue untouched', async () => {
      const { id } = await uploadedPhoto();
      await t.sql(`
        CREATE OR REPLACE FUNCTION s29_fail_history() RETURNS trigger AS $$
        BEGIN
          IF NEW."toStatus" = 'UPLOADED' THEN RAISE EXCEPTION 's29 forced rollback'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql;
        CREATE TRIGGER s29_fail_history BEFORE INSERT ON "MediaStatusHistory" FOR EACH ROW EXECUTE FUNCTION s29_fail_history();
      `);
      try {
        const res = await complete(w.staff, id);
        expect(res.status).toBe(500);
        expect((await t.row(id))!.status).toBe('PENDING_UPLOAD');
        expect(t.queue.sent).toHaveLength(0);
      } finally {
        await t.sql(
          `DROP TRIGGER IF EXISTS s29_fail_history ON "MediaStatusHistory"; DROP FUNCTION IF EXISTS s29_fail_history();`,
        );
      }
    });

    it('S29 AS-08: a missing object is 409 upload_incomplete, and the same call succeeds once the object is there', async () => {
      const created = mediaUploadResponseSchema.parse(
        (await shopUpload(w.staff, w.shop.id).expect(201)).body,
      );
      const refused = await complete(w.staff, created.mediaId).expect(409);
      expect(refused.body.code).toBe('upload_incomplete');
      expect((await t.row(created.mediaId))!.status).toBe('PENDING_UPLOAD');
      expect(t.queue.sent).toHaveLength(0);
      await t.putOriginal(
        created.upload.fields.key,
        await photo({ width: 300, height: 200 }),
      );
      await complete(w.staff, created.mediaId).expect(202);
    });

    it.each([
      ['an empty object', () => Buffer.alloc(0)],
      ['an object over 15 MiB', () => manyBytes(15 * 1024 * 1024 + 1)],
    ])(
      'S29 AS-08: %s is rejected as size_invalid and deleted',
      async (_name, bytes) => {
        const created = mediaUploadResponseSchema.parse(
          (await shopUpload(w.staff, w.shop.id).expect(201)).body,
        );
        await t.putOriginal(created.upload.fields.key, bytes());
        const res = await complete(w.staff, created.mediaId).expect(200);
        expect(mediaCompleteResponseSchema.parse(res.body)).toEqual({
          status: 'REJECTED',
          rejectCode: 'size_invalid',
        });
        expect(await t.objectExists(created.upload.fields.key)).toBe(false);
        expect((await t.row(created.mediaId))!).toMatchObject({
          status: 'REJECTED',
          rejectCode: 'size_invalid',
        });
        expect(await t.outbox('media.rejected')).toHaveLength(1);
        expect(t.queue.sent).toHaveLength(0);
      },
    );

    it('S29 AS-09: two simultaneous completes both answer 202, one transition happens, one message is sent', async () => {
      const { id } = await uploadedPhoto();
      const [a, b] = await Promise.all([
        complete(w.staff, id),
        complete(w.staff, id),
      ]);
      expect([a.status, b.status]).toEqual([202, 202]);
      expect(t.queue.sent).toHaveLength(1);
      expect(
        (await t.history(id)).filter((h) => h.toStatus === 'UPLOADED'),
      ).toHaveLength(1);
    });

    it.each([
      ['UPLOADED', 202, 'UPLOADED'],
      ['PROCESSING', 202, 'PROCESSING'],
      ['READY', 200, 'READY'],
      ['REJECTED', 200, 'REJECTED'],
    ] as const)(
      'S29 AS-09: a replay on %s answers %s from state and sends nothing',
      async (status, http, expected) => {
        const { id } = await t.photo({
          shopId: w.shop.id,
          uploaderId: w.staff.id,
          status,
          rejectCode: status === 'REJECTED' ? 'not_an_image' : null,
        });
        const res = await complete(w.staff, id).expect(http);
        expect(res.body.status).toBe(expected);
        expect(t.queue.sent).toHaveLength(0);
      },
    );

    it('S29 AS-10: EXPIRED is 409 upload_expired; DELETED, unknown and not-yours are the same 404; a non-UUID is 400; no credentials 401', async () => {
      const expired = await t.photo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status: 'EXPIRED',
      });
      expect((await complete(w.staff, expired.id).expect(409)).body.code).toBe(
        'upload_expired',
      );
      const deleted = await t.photo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status: 'DELETED',
      });
      const other = await t.photo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
      });
      const gone = await complete(w.staff, deleted.id).expect(404);
      const unknown = await complete(w.staff, randomUUID()).expect(404);
      const notYours = await complete(w.buyer, other.id).expect(404);
      expect(stable(gone.body)).toEqual(stable(unknown.body));
      expect(stable(notYours.body)).toEqual(stable(unknown.body));
      expect(gone.body.code).toBe('media_not_found');
      expect(
        (await complete(w.staff, 'not-a-uuid').expect(400)).body.code,
      ).toBe('validation_failed');
      await t.http().post(`/api/media/${other.id}/complete`).expect(401);
    });
  });

  // Last on purpose: a second application in the same process rebinds the model classes to its own connection, which
  // is closed with it; every describe above must have finished with the first one.
  describe('S29 US1: rate limiter outage', () => {
    let down: MediaTestApp;
    beforeAll(async () => {
      down = await createMediaApp({ redisProxy: true });
    });
    afterAll(() => down.close());

    it('S29 AS-05: when the limiter store is down uploads fail closed with a generic 503 and no row', async () => {
      await down.reset();
      const world = await down.world();
      await down
        .as(world.buyer)
        .post('/api/media/uploads')
        .send({ purpose: 'review' })
        .expect(201);
      down.proxies[0].mode = 'refuse';
      try {
        const res = await down
          .as(world.buyer)
          .post('/api/media/uploads')
          .send({ purpose: 'review' });
        expect(res.status).toBe(503);
        expect(res.headers['content-type']).toMatch(/problem\+json|json/);
        expect(res.body).toEqual(
          expect.objectContaining({ status: 503, title: expect.any(String) }),
        );
        expect(JSON.stringify(res.body)).not.toMatch(
          /redis|ECONN|127\.0\.0\.1/i,
        );
        const rows = await down.sql<{ n: string }>(
          `SELECT count(*) AS n FROM "Media"`,
        );
        expect(Number(rows[0].n)).toBe(1);
      } finally {
        down.proxies[0].mode = 'pass';
      }
    });
  });
});
