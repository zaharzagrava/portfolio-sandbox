import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  videoCompleteResponseSchema,
  videoStartResponseSchema,
  videoUploadStateSchema,
  type VideoStartResponse,
} from '@marketplace-sandbox/contracts';
import { ProductQueryService } from '@app/domains/catalog';
import { getActiveTransaction } from '@app/infrastructure/context/transaction-scope';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { TestUser } from '@app/test/utils/catalog-app';
import {
  MIN_PART_SIZE,
  createVideoApp,
  type VideoTestApp,
  type VideoWorld,
} from './testing/video-app';
import { createShop } from '@app/test/utils/tenancy-fixtures';

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

const valid = (over: Record<string, unknown> = {}) => ({
  title: 'Launch demo',
  sizeBytes: 200_000_000,
  contentType: 'video/mp4',
  visibility: 'public',
  ...over,
});

describe('Video upload API', () => {
  let t: VideoTestApp;
  let w: VideoWorld;

  beforeAll(async () => {
    t = await createVideoApp({ storageProxy: true });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    w = await t.world();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const proxy of t.proxies) proxy.mode = 'pass';
  });

  const start = (user: TestUser, shopId: string, body: unknown = valid()) =>
    t
      .as(user)
      .post(`/api/shops/${shopId}/videos`)
      .send(body as object);
  const resume = (user: TestUser, shopId: string, id: string) =>
    t.as(user).get(`/api/shops/${shopId}/videos/${id}/upload`);
  const complete = (
    user: TestUser,
    shopId: string,
    id: string,
    parts: unknown = [{ partNumber: 1, etag: 'x' }],
  ) =>
    t
      .as(user)
      .post(`/api/shops/${shopId}/videos/${id}/complete`)
      .send({ parts });
  const count = async (where = 'TRUE') =>
    Number(
      (
        await t.sql<{ n: string }>(
          `SELECT count(*) AS n FROM "Video" WHERE ${where}`,
        )
      )[0].n,
    );
  /** Starts a small real upload with parts of the store's minimum size. */
  const startReal = async (
    parts: number,
    over: Record<string, unknown> = {},
    user: TestUser = w.staff,
  ) => {
    t.partSize.value = MIN_PART_SIZE;
    const res = await start(
      user,
      w.shop.id,
      valid({ sizeBytes: (parts - 1) * MIN_PART_SIZE + 1000, ...over }),
    ).expect(201);
    return videoStartResponseSchema.parse(res.body);
  };
  const watchTransactions = (target: object, names: string[]) => {
    const seen: string[] = [];
    for (const name of names) {
      const original = (target as Record<string, (...a: unknown[]) => unknown>)[
        name
      ].bind(target);
      jest.spyOn(target as never, name as never).mockImplementation(((
        ...args: unknown[]
      ) => {
        if (getActiveTransaction()) seen.push(name);
        return original(...args);
      }) as never);
    }
    return seen;
  };

  describe('S30 US1: start', () => {
    it('S30 AS-01: a STAFF member gets a slot with exact-length part permissions and no key or upload id', async () => {
      const T = t.clock.now();
      const res = await start(w.staff, w.shop.id).expect(201);
      const body = videoStartResponseSchema.parse(res.body);
      expect(body).toMatchObject({
        partSize: 67_108_864,
        partCount: 3,
        visibility: 'public',
        shareToken: null,
        expiresAt: new Date(T.getTime() + 24 * 3_600_000).toISOString(),
      });
      expect(body.parts.map((p) => p.contentLength)).toEqual([
        67_108_864, 67_108_864, 65_782_272,
      ]);
      expect(body.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
      const row = (await t.row(body.videoId))!;
      expect(row).toMatchObject({
        status: 'UPLOADING',
        version: 1,
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        sizeBytes: '200000000',
      });
      expect(row.sourceKey).toBe(`vsrc/${body.videoId}/source`);
      // The part URLs are the only place the store's address appears (a presigned URL names its object); everything
      // else in the answer, and every property name, is free of the key and the upload id.
      const { parts: _urls, ...rest } = res.body;
      void _urls;
      const json = JSON.stringify(rest);
      expect(json).not.toContain(row.sourceKey);
      expect(json).not.toContain(row.uploadId);
      expect(Object.keys(res.body).sort()).toEqual([
        'expiresAt',
        'partCount',
        'partSize',
        'parts',
        'shareToken',
        'videoId',
        'visibility',
      ]);
      expect(Object.keys(res.body.parts[0]).sort()).toEqual([
        'contentLength',
        'partNumber',
        'url',
      ]);
      expect(Buffer.byteLength(JSON.stringify(valid()))).toBeLessThan(4096);
      expect(await t.history(body.videoId)).toEqual([
        {
          fromStatus: null,
          toStatus: 'UPLOADING',
          actorType: 'user',
          failureCode: null,
        },
      ]);
      // each URL signs its own part number, an hour, and the length as a signed header
      const url = new URL(body.parts[2].url);
      expect(url.searchParams.get('partNumber')).toBe('3');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain(
        'content-length',
      );
    });

    it('S30 AS-01: an unlisted video gets a random share token of at least 128 bits, a public one gets null', async () => {
      const a = videoStartResponseSchema.parse(
        (
          await start(
            w.staff,
            w.shop.id,
            valid({ visibility: 'unlisted' }),
          ).expect(201)
        ).body,
      );
      const b = videoStartResponseSchema.parse(
        (
          await start(
            w.staff,
            w.shop.id,
            valid({ visibility: 'unlisted' }),
          ).expect(201)
        ).body,
      );
      expect(a.shareToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(a.shareToken).not.toBe(b.shareToken);
      expect((await t.row(a.videoId))!.shareToken).toBe(a.shareToken);
    });

    it.each([
      ['no body', {}],
      ['empty title', valid({ title: '' })],
      ['blank title', valid({ title: '   ' })],
      ['title over 200 characters', valid({ title: 'x'.repeat(201) })],
      ['zero size', valid({ sizeBytes: 0 })],
      ['negative size', valid({ sizeBytes: -5 })],
      ['fractional size', valid({ sizeBytes: 1500.5 })],
      ['size under 1,024', valid({ sizeBytes: 1023 })],
      ['size over 20 GiB', valid({ sizeBytes: 21_474_836_481 })],
      ['unknown visibility', valid({ visibility: 'private' })],
      ['unknown content type', valid({ contentType: 'video/avi' })],
      ['non-UUID product', valid({ productId: 'not-a-uuid' })],
      ['unknown field status', valid({ status: 'READY' })],
      ['unknown field shopId', valid({ shopId: randomUUID() })],
      ['unknown field key', valid({ key: 'vsrc/x' })],
      ['unknown field uploadId', valid({ uploadId: 'u' })],
      ['unknown field partSize', valid({ partSize: 5 })],
    ])(
      'S30 AS-02: %s is 400 validation_failed, nothing stored, no storage call',
      async (_name, body) => {
        const spy = jest.spyOn(t.storage, 'startMultipartUpload');
        const res = await start(w.staff, w.shop.id, body).expect(400);
        expect(res.body.code).toBe('validation_failed');
        expect(await count()).toBe(0);
        expect(spy).not.toHaveBeenCalled();
      },
    );

    it.each([1024, 21_474_836_480])(
      'S30 AS-02: exactly %d bytes is accepted',
      async (sizeBytes) => {
        const res = await start(
          w.staff,
          w.shop.id,
          valid({ sizeBytes }),
        ).expect(201);
        const body = videoStartResponseSchema.parse(res.body);
        expect(body.parts.reduce((s, p) => s + p.contentLength, 0)).toBe(
          sizeBytes,
        );
      },
    );

    it('S30 AS-03: 401 without credentials, 403 for a VIEWER, one identical 404 for a non-member and an unknown shop', async () => {
      await t
        .http()
        .post(`/api/shops/${w.shop.id}/videos`)
        .send(valid())
        .expect(401);
      expect((await start(w.viewer, w.shop.id).expect(403)).body.code).toBe(
        'permission_denied',
      );
      const stranger = await start(w.outsider, w.shop.id).expect(404);
      const unknown = await start(w.outsider, randomUUID()).expect(404);
      expect(stable(stranger.body)).toEqual(stable(unknown.body));
      expect(await count()).toBe(0);
    });

    it('S30 AS-03: a suspended shop is 403 shop_suspended, one being closed is 409 shop_offboarding', async () => {
      const suspended = await createShop(t.app, w.owner, {
        status: 'SUSPENDED',
      });
      const closing = await createShop(t.app, w.owner, { status: 'DELETING' });
      expect((await start(w.owner, suspended.id).expect(403)).body.code).toBe(
        'shop_suspended',
      );
      expect((await start(w.owner, closing.id).expect(409)).body.code).toBe(
        'shop_offboarding',
      );
      expect(await count()).toBe(0);
    });

    it('S30 AS-04: an ACTIVE product of the shop links; unknown and foreign are the same 404; archived is 409; one batch read', async () => {
      const own = await t.product(w.shop.id);
      const foreign = await t.product(w.otherShop.id);
      const archived = await t.product(w.shop.id, { status: 'ARCHIVED' });
      const read = jest.spyOn(
        t.app.get(ProductQueryService),
        'getProductsByIds',
      );

      const ok = await start(
        w.staff,
        w.shop.id,
        valid({ productId: own.id }),
      ).expect(201);
      expect(read).toHaveBeenCalledTimes(1);
      expect((await t.row(ok.body.videoId))!.productId).toBe(own.id);

      const unknown = await start(
        w.staff,
        w.shop.id,
        valid({ productId: randomUUID() }),
      ).expect(404);
      const other = await start(
        w.staff,
        w.shop.id,
        valid({ productId: foreign.id }),
      ).expect(404);
      expect(unknown.body.code).toBe('product_not_found');
      expect(stable(unknown.body)).toEqual(stable(other.body));
      expect(
        (
          await start(
            w.staff,
            w.shop.id,
            valid({ productId: archived.id }),
          ).expect(409)
        ).body.code,
      ).toBe('product_archived');
      expect(await count()).toBe(1);
    });

    it('S30 AS-05: with 9 pending uploads, five concurrent starts give one 201 and four 409 pending_uploads_limit', async () => {
      for (let i = 0; i < 9; i++)
        await t.video({ shopId: w.shop.id, uploaderId: w.staff.id });
      const answers = await Promise.all(
        Array.from({ length: 5 }, () =>
          start(w.staff, w.shop.id, valid({ sizeBytes: 2048 })),
        ),
      );
      expect(answers.map((a) => a.status).sort()).toEqual([
        201, 409, 409, 409, 409,
      ]);
      for (const refused of answers.filter((a) => a.status === 409))
        expect(refused.body).toMatchObject({
          code: 'pending_uploads_limit',
          limit: 10,
          current: 10,
        });
      expect(await count(`"status" = 'UPLOADING'`)).toBe(10);

      // freeing one slot (expired) lets the shop start again
      const [{ id }] = await t.sql<{ id: string }>(
        `SELECT "id" FROM "Video" WHERE "status" = 'UPLOADING' LIMIT 1`,
      );
      await t.sql(
        `UPDATE "Video" SET "status" = 'EXPIRED' WHERE "id" = :id RETURNING 1`,
        { id },
      );
      await start(w.staff, w.shop.id, valid({ sizeBytes: 2048 })).expect(201);
    });

    it('S30 AS-06: the 21st start in an hour is 429 with Retry-After and creates no row', async () => {
      for (let i = 0; i < 20; i++)
        await start(w.owner, w.shop.id, valid({ sizeBytes: 2048 })); // the first ten create slots, the rest are 409
      const before = await count();
      const limited = await start(
        w.owner,
        w.shop.id,
        valid({ sizeBytes: 2048 }),
      ).expect(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(await count()).toBe(before);
    });

    it('S30 AS-06: the 121st write of a shop in a minute is 429', async () => {
      const { id } = await t.video({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status: 'READY',
      });
      for (let i = 0; i < 120; i++)
        await resume(w.owner, w.shop.id, id).expect(409);
      const limited = await resume(w.owner, w.shop.id, id).expect(429);
      expect(limited.headers['retry-after']).toBeDefined();
    });

    it('S30 AS-07: storage refusing or hanging at start is a 503 within 5 s, the slot is EXPIRED and counts for nothing; a retry works', async () => {
      const proxy = t.storageProxy!;
      for (const mode of ['refuse', 'hang'] as const) {
        proxy.mode = mode;
        const began = Date.now();
        const res = await start(w.staff, w.shop.id, valid({ sizeBytes: 2048 }));
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('storage_unavailable');
        expect(Date.now() - began).toBeLessThan(5000);
        expect(JSON.stringify(res.body)).not.toMatch(
          /ECONN|127\.0\.0\.1|minio|vsrc/i,
        );
        proxy.mode = 'pass';
      }
      expect(await count(`"status" = 'UPLOADING'`)).toBe(0);
      const expired = await t.sql<{ id: string }>(
        `SELECT "id" FROM "Video" WHERE "status" = 'EXPIRED'`,
      );
      expect(expired).toHaveLength(2);
      for (const { id } of expired)
        expect((await t.history(id)).map((h) => h.toStatus)).toEqual([
          'UPLOADING',
          'EXPIRED',
        ]);
      await start(w.staff, w.shop.id, valid({ sizeBytes: 2048 })).expect(201);
    }, 30_000);
  });

  describe('S30 US1: the store enforces each part permission', () => {
    it('S30 AS-08: the right body is stored; one byte more or less, another part length, an expired URL and a changed upload id are refused', async () => {
      t.partSize.value = MIN_PART_SIZE;
      const started = videoStartResponseSchema.parse(
        (
          await start(
            w.staff,
            w.shop.id,
            valid({ sizeBytes: 2 * MIN_PART_SIZE + 10 }),
          ).expect(201)
        ).body,
      );
      const [p1, p2, p3] = started.parts;
      const row = (await t.row(started.videoId))!;
      const stored = async () =>
        ((await t.storage.listParts(row.sourceKey, row.uploadId)) ?? []).map(
          (p) => [p.partNumber, p.size],
        );

      expect(
        (await t.putPart(p1.url, Buffer.alloc(MIN_PART_SIZE + 1))).status,
      ).toBe(403);
      expect(
        (await t.putPart(p1.url, Buffer.alloc(MIN_PART_SIZE - 1))).status,
      ).toBe(403);
      expect(
        (await t.putPart(p1.url, Buffer.alloc(p3.contentLength))).status,
      ).toBe(403);
      expect(await stored()).toEqual([]);

      // part 1's URL can only ever write part 1, whatever the bytes
      expect(
        (await t.putPart(p1.url, Buffer.alloc(MIN_PART_SIZE, 9))).status,
      ).toBe(200);
      expect(await stored()).toEqual([[1, MIN_PART_SIZE]]);

      // a URL for the same part that ran out of time
      const shortLived = await t.storage.presignUploadPart(
        row.sourceKey,
        row.uploadId,
        2,
        MIN_PART_SIZE,
        1,
      );
      await sleep(2100);
      expect(
        (await t.putPart(shortLived, Buffer.alloc(MIN_PART_SIZE))).status,
      ).toBe(403);

      // another video's upload id in this video's URL breaks the signature
      const other = videoStartResponseSchema.parse(
        (
          await start(w.staff, w.shop.id, valid({ sizeBytes: 2048 })).expect(
            201,
          )
        ).body,
      );
      const otherRow = (await t.row(other.videoId))!;
      const forged = new URL(p2.url);
      forged.searchParams.set('uploadId', otherRow.uploadId);
      expect(
        (await t.putPart(forged.toString(), Buffer.alloc(MIN_PART_SIZE)))
          .status,
      ).toBe(403);
      expect(await stored()).toEqual([[1, MIN_PART_SIZE]]);
    }, 60_000);
  });

  describe('S30 US1: resume', () => {
    it('S30 AS-09: 7 of 12 parts in storage → uploaded and missing lists, fresh permissions for the missing ones, same expiry', async () => {
      const started = await startReal(12);
      await t.uploadParts(started, { only: [1, 2, 3, 4, 5, 6, 7] });
      t.clock.advance(60_000);
      const res = await resume(w.staff, w.shop.id, started.videoId).expect(200);
      const state = videoUploadStateSchema.parse(res.body);
      expect(state.partCount).toBe(12);
      expect(state.uploadedParts.map((p) => p.partNumber)).toEqual([
        1, 2, 3, 4, 5, 6, 7,
      ]);
      expect(state.uploadedParts.every((p) => p.size === MIN_PART_SIZE)).toBe(
        true,
      );
      expect(state.missingParts).toEqual([8, 9, 10, 11, 12]);
      expect(state.parts.map((p) => p.partNumber)).toEqual([8, 9, 10, 11, 12]);
      expect(state.expiresAt).toBe(started.expiresAt); // resume never extends the session
      expect(Cache(res)).toBe('no-store');
    }, 120_000);

    it.each(['UPLOADED', 'PROCESSING', 'READY', 'FAILED'] as const)(
      'S30 AS-09: a %s video answers 409 upload_closed with its status',
      async (status) => {
        const { id } = await t.video({
          shopId: w.shop.id,
          uploaderId: w.staff.id,
          status,
        });
        const res = await resume(w.staff, w.shop.id, id).expect(409);
        expect(res.body).toMatchObject({
          code: 'upload_closed',
          videoStatus: status,
        });
      },
    );

    it("S30 AS-09: EXPIRED, DELETED, unknown and another shop's video are the same hidden 404", async () => {
      const expired = await t.video({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status: 'EXPIRED',
      });
      const deleted = await t.video({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status: 'DELETED',
      });
      const foreign = await t.video({
        shopId: w.otherShop.id,
        uploaderId: w.otherOwner.id,
      });
      const answers = [
        await resume(w.staff, w.shop.id, expired.id).expect(404),
        await resume(w.staff, w.shop.id, deleted.id).expect(404),
        await resume(w.staff, w.shop.id, randomUUID()).expect(404),
        await resume(w.staff, w.shop.id, foreign.id).expect(404),
      ];
      for (const a of answers)
        expect(stable(a.body)).toEqual(stable(answers[0].body));
      expect(answers[0].body.code).toBe('video_not_found');
    });
  });

  describe('S30 US1: complete', () => {
    it('S30 AS-10: all parts in storage → 202 PROCESSING, assembled source of the declared size, one probe task, one message after commit, no storage or queue call inside a transaction', async () => {
      const started = await startReal(2);
      const etags = await t.uploadParts(started);
      const inTx = [
        ...watchTransactions(t.storage, [
          'head',
          'completeMultipartUpload',
          'listParts',
          'delete',
        ]),
        ...[],
      ];
      const queueInTx = watchTransactions(t.queue, ['enqueue']);

      const res = await complete(
        w.staff,
        w.shop.id,
        started.videoId,
        etags,
      ).expect(202);
      expect(videoCompleteResponseSchema.parse(res.body)).toEqual({
        status: 'PROCESSING',
      });
      const row = (await t.row(started.videoId))!;
      expect(row.status).toBe('PROCESSING');
      expect((await t.storage.head(row.sourceKey))!.size).toBe(
        MIN_PART_SIZE + 1000,
      );
      expect(
        (await t.history(started.videoId)).map(
          (h) => `${h.fromStatus}>${h.toStatus}`,
        ),
      ).toEqual([
        'null>UPLOADING',
        'UPLOADING>UPLOADED',
        'UPLOADED>PROCESSING',
      ]);
      const tasks = await t.tasks(started.videoId);
      expect(tasks.map((x) => [x.name, x.status])).toEqual([
        ['probe', 'QUEUED'],
      ]);
      expect(t.queue.pending().map((m) => m.body)).toEqual([
        { videoId: started.videoId, task: 'probe' },
      ]);
      expect(inTx).toEqual([]);
      expect(queueInTx).toEqual([]);
    }, 120_000);

    it('S30 AS-11: parts 1-7 of 12 → 409 upload_incomplete naming 8-12, status unchanged, no message', async () => {
      const started = await startReal(12);
      const etags = await t.uploadParts(started, {
        only: [1, 2, 3, 4, 5, 6, 7],
      });
      const res = await complete(
        w.staff,
        w.shop.id,
        started.videoId,
        etags,
      ).expect(409);
      expect(res.body).toMatchObject({
        code: 'upload_incomplete',
        missingParts: [8, 9, 10, 11, 12],
      });
      expect((await t.row(started.videoId))!.status).toBe('UPLOADING');
      expect(t.queue.pending()).toHaveLength(0);
    }, 120_000);

    it('S30 AS-11: a wrong etag, a part number the video does not have and a short list are 422; duplicate, unsorted and empty lists are 400', async () => {
      const started = await startReal(2);
      const etags = await t.uploadParts(started);
      const id = started.videoId;
      const wrong = [{ ...etags[0], etag: '"deadbeef"' }, etags[1]];
      expect(
        (await complete(w.staff, w.shop.id, id, wrong).expect(422)).body.code,
      ).toBe('parts_mismatch');
      const extra = [...etags, { partNumber: 3, etag: etags[0].etag }];
      expect(
        (await complete(w.staff, w.shop.id, id, extra).expect(422)).body.code,
      ).toBe('parts_mismatch');
      expect(
        (await complete(w.staff, w.shop.id, id, [etags[0]]).expect(422)).body
          .code,
      ).toBe('parts_mismatch');
      for (const bad of [[], [etags[0], etags[0]], [etags[1], etags[0]]])
        expect(
          (await complete(w.staff, w.shop.id, id, bad).expect(400)).body.code,
        ).toBe('validation_failed');
      expect((await t.row(id))!.status).toBe('UPLOADING');
      expect(t.queue.pending()).toHaveLength(0);
    }, 120_000);

    it('S30 AS-12: two concurrent completes both answer 202 PROCESSING with one transition, one assembly, one task and one message', async () => {
      const started = await startReal(2);
      const etags = await t.uploadParts(started);
      const assemble = jest.spyOn(t.storage, 'completeMultipartUpload');
      const [a, b] = await Promise.all([
        complete(w.staff, w.shop.id, started.videoId, etags),
        complete(w.owner, w.shop.id, started.videoId, etags),
      ]);
      expect([a.status, b.status]).toEqual([202, 202]);
      expect([a.body.status, b.body.status]).toEqual([
        'PROCESSING',
        'PROCESSING',
      ]);
      expect(assemble).toHaveBeenCalledTimes(1);
      expect(
        (await t.history(started.videoId)).filter(
          (h) => h.toStatus === 'UPLOADED',
        ),
      ).toHaveLength(1);
      expect(await t.tasks(started.videoId)).toHaveLength(1);
      expect(t.queue.pending()).toHaveLength(1);

      // a replay on PROCESSING: 202, nothing new
      const replay = await complete(
        w.staff,
        w.shop.id,
        started.videoId,
        etags,
      ).expect(202);
      expect(replay.body).toEqual({ status: 'PROCESSING' });
      expect(t.queue.pending()).toHaveLength(1);
    }, 120_000);

    it('S30 AS-12: a replay on READY is 200 READY, on FAILED 200 with the failure code; neither sends a message', async () => {
      const ready = await t.video({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status: 'READY',
      });
      const failed = await t.video({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status: 'FAILED',
        failureCode: 'not_a_video',
      });
      expect(
        (await complete(w.staff, w.shop.id, ready.id).expect(200)).body,
      ).toEqual({ status: 'READY' });
      expect(
        (await complete(w.staff, w.shop.id, failed.id).expect(200)).body,
      ).toEqual({
        status: 'FAILED',
        failureCode: 'not_a_video',
      });
      expect(t.queue.pending()).toHaveLength(0);
    });

    it("S30 AS-13: EXPIRED is 409 upload_expired; DELETED, unknown and another shop's video are one 404; bad id 400; 401; VIEWER 403", async () => {
      const expired = await t.video({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status: 'EXPIRED',
      });
      const deleted = await t.video({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status: 'DELETED',
      });
      const foreign = await t.video({
        shopId: w.otherShop.id,
        uploaderId: w.otherOwner.id,
      });
      expect(
        (await complete(w.staff, w.shop.id, expired.id).expect(409)).body.code,
      ).toBe('upload_expired');
      const answers = [
        await complete(w.staff, w.shop.id, deleted.id).expect(404),
        await complete(w.staff, w.shop.id, randomUUID()).expect(404),
        await complete(w.staff, w.shop.id, foreign.id).expect(404),
      ];
      for (const a of answers)
        expect(stable(a.body)).toEqual(stable(answers[0].body));
      expect(
        (await complete(w.staff, w.shop.id, 'not-a-uuid').expect(400)).body
          .code,
      ).toBe('validation_failed');
      await t
        .http()
        .post(`/api/shops/${w.shop.id}/videos/${expired.id}/complete`)
        .send({ parts: [{ partNumber: 1, etag: 'x' }] })
        .expect(401);
      await complete(w.viewer, w.shop.id, expired.id).expect(403);
    });

    it('S30 AS-14: storage failing the assembly is a 503 with the video still UPLOADED; a retry after an assembly that did happen proceeds without NoSuchUpload', async () => {
      const started = await startReal(2);
      const etags = await t.uploadParts(started);
      const row = (await t.row(started.videoId))!;
      const real = t.storage.completeMultipartUpload.bind(t.storage);
      jest
        .spyOn(t.storage, 'completeMultipartUpload')
        .mockImplementationOnce(async (...args) => {
          t.storageProxy!.mode = 'refuse';
          try {
            return await real(...args);
          } finally {
            t.storageProxy!.mode = 'pass';
          }
        });
      const failed = await complete(w.staff, w.shop.id, started.videoId, etags);
      expect(failed.status).toBe(503);
      expect(failed.body.code).toBe('storage_unavailable');
      expect((await t.row(started.videoId))!.status).toBe('UPLOADED');
      expect(t.queue.pending()).toHaveLength(0);

      // the assembly happens behind the API's back (the answer to the first call was lost); the retry re-heads the source
      await t.storage.completeMultipartUpload(
        row.sourceKey,
        row.uploadId,
        etags,
      );
      const retried = await complete(
        w.staff,
        w.shop.id,
        started.videoId,
        etags,
      ).expect(202);
      expect(retried.body).toEqual({ status: 'PROCESSING' });
      expect(t.queue.pending()).toHaveLength(1);
    }, 120_000);

    it('S30 AS-14: after a failed assembly the retry assembles itself and sends one message', async () => {
      const started = await startReal(2);
      const etags = await t.uploadParts(started);
      const real = t.storage.completeMultipartUpload.bind(t.storage);
      jest
        .spyOn(t.storage, 'completeMultipartUpload')
        .mockImplementationOnce(async (...args) => {
          t.storageProxy!.mode = 'refuse';
          try {
            return await real(...args);
          } finally {
            t.storageProxy!.mode = 'pass';
          }
        });
      await complete(w.staff, w.shop.id, started.videoId, etags).expect(503);
      const retried = await complete(
        w.staff,
        w.shop.id,
        started.videoId,
        etags,
      ).expect(202);
      expect(retried.body.status).toBe('PROCESSING');
      expect(t.queue.pending()).toHaveLength(1);
      expect(await t.tasks(started.videoId)).toHaveLength(1);
    }, 120_000);

    it('S30 AS-14: a source whose size differs from the declared one is FAILED source_size_mismatch, the source is deleted, one video.failed and no task', async () => {
      const started = await startReal(2);
      const etags = await t.uploadParts(started);
      const row = (await t.row(started.videoId))!;
      await t.storage.put(row.sourceKey, Buffer.alloc(77), 'video/mp4'); // not what was declared
      const res = await complete(
        w.staff,
        w.shop.id,
        started.videoId,
        etags,
      ).expect(200);
      expect(res.body).toEqual({
        status: 'FAILED',
        failureCode: 'source_size_mismatch',
      });
      expect((await t.row(started.videoId))!).toMatchObject({
        status: 'FAILED',
        failureCode: 'source_size_mismatch',
      });
      expect(await t.objectExists(row.sourceKey)).toBe(false);
      expect(await t.tasks(started.videoId)).toHaveLength(0);
      const events = await t.outbox('video.failed');
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        videoId: started.videoId,
        failureCode: 'source_size_mismatch',
      });
      expect(t.queue.pending()).toHaveLength(0);
    }, 120_000);
  });

  // Last on purpose: a second application in the same process rebinds the model classes to its own connection, which
  // is closed with it; every describe above must have finished with the first one.
  describe('S30 US1: rate limiter outage', () => {
    let down: VideoTestApp;
    beforeAll(async () => {
      down = await createVideoApp({ redisProxy: true });
    });
    afterAll(() => down.close());

    it('S30 AS-06: when the limiter store is down starting an upload fails closed with a generic 503 and no row', async () => {
      await down.reset();
      const world = await down.world();
      const post = () =>
        down
          .as(world.staff)
          .post(`/api/shops/${world.shop.id}/videos`)
          .send(valid({ sizeBytes: 2048 }));
      await post().expect(201);
      // Cut the connection and wait until the client has noticed, so no command is written into a dying socket.
      down.redisProxy!.mode = 'refuse';
      down.redisProxy!.sever();
      const redis = down.app.get(RedisService);
      for (let i = 0; i < 500 && redis.client.status === 'ready'; i++)
        await sleep(10);
      try {
        const res = await post();
        expect(res.status).toBe(503);
        expect(res.body).toEqual(
          expect.objectContaining({ status: 503, title: expect.any(String) }),
        );
        expect(JSON.stringify(res.body)).not.toMatch(
          /redis|ECONN|127\.0\.0\.1/i,
        );
        const rows = await down.sql<{ n: string }>(
          `SELECT count(*) AS n FROM "Video"`,
        );
        expect(Number(rows[0].n)).toBe(1);
      } finally {
        down.redisProxy!.mode = 'pass';
      }
    }, 60_000);
  });
});

const Cache = (res: { headers: Record<string, string> }) =>
  res.headers['cache-control'];

export type { VideoStartResponse };
