import { randomUUID } from 'node:crypto';
import {
  videoListSchema,
  videoOwnerSchema,
  videoStartResponseSchema,
  type VideoOwner,
} from '@marketplace-sandbox/contracts';
import { ProductQueryService } from '@app/domains/catalog';
import type { TestUser } from '@app/test/utils/catalog-app';
import type { VideoOutputs } from './domain/video-ports';
import { fakeVideo } from './testing/test-videos';
import {
  MIN_PART_SIZE,
  createVideoApp,
  type VideoTestApp,
  type VideoWorld,
} from './testing/video-app';

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

const OUTPUTS: VideoOutputs = {
  master: 'master.m3u8',
  poster: 'poster/a1/poster.jpg',
  sprite: null,
  renditions: [
    {
      name: '720p',
      width: 1280,
      height: 720,
      bandwidth: 3_000_000,
      averageBandwidth: 2_600_000,
      frameRate: 30,
      codecs: 'avc1.4d401f,mp4a.40.2',
    },
  ],
};

describe('Video management API', () => {
  let t: VideoTestApp;
  let w: VideoWorld;

  beforeAll(async () => {
    t = await createVideoApp({ worker: true });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    t.encoder!.uninstall();
    await t.reset();
    w = await t.world();
  });
  afterEach(() => {
    t.encoder!.uninstall();
    jest.restoreAllMocks();
  });

  const seed = (
    over: Record<string, unknown> = {},
    shop = w.shop,
    user = w.staff,
  ) =>
    t.video({
      shopId: shop.id,
      uploaderId: user.id,
      status: 'READY',
      outputs: OUTPUTS,
      durationSec: 6,
      width: 1280,
      height: 720,
      ...over,
    });
  const get = (user: TestUser, shopId: string, id: string) =>
    t.as(user).get(`/api/shops/${shopId}/videos/${id}`);
  const list = (user: TestUser, shopId: string, query = '') =>
    t.as(user).get(`/api/shops/${shopId}/videos${query}`);
  const patch = (user: TestUser, shopId: string, id: string, body: unknown) =>
    t
      .as(user)
      .patch(`/api/shops/${shopId}/videos/${id}`)
      .send(body as object);
  const retry = (user: TestUser, shopId: string, id: string) =>
    t.as(user).post(`/api/shops/${shopId}/videos/${id}/retry`);
  const remove = (user: TestUser, shopId: string, id: string) =>
    t.as(user).delete(`/api/shops/${shopId}/videos/${id}`);
  const row = async (id: string) => (await t.row(id))!;

  describe('S30 US4: read one', () => {
    it('S30 AS-42: the owner view has the fields of the schema and never a location, an upload id or encoder text', async () => {
      const ok = await seed({ visibility: 'unlisted' });
      const failed = await seed({
        status: 'FAILED',
        failureCode: 'transcode_failed',
        outputs: undefined,
      });
      await t.sql(
        `UPDATE "Video" SET "internalError" = 'ffmpeg: Conversion failed! /tmp/secret/path x264' WHERE "id" = :id RETURNING 1`,
        { id: failed.id },
      );
      const res = await get(w.staff, w.shop.id, ok.id).expect(200);
      const body = videoOwnerSchema.parse(res.body);
      expect(body).toMatchObject({
        id: ok.id,
        status: 'READY',
        visibility: 'unlisted',
        failureCode: null,
        retryable: false,
        durationSec: 6,
        width: 1280,
        height: 720,
        shareToken: (await row(ok.id)).shareToken,
        posterUrl: `${(process.env.VIDEO_CDN_URL || 'https://stream.localhost').replace(/\/+$/, '')}/u/${ok.id}/poster/a1/poster.jpg`,
        spriteUrl: null,
        version: 1,
      });
      expect(body.renditions).toEqual([
        { name: '720p', width: 1280, height: 720 },
      ]);
      const failedBody = videoOwnerSchema.parse(
        (await get(w.staff, w.shop.id, failed.id).expect(200)).body,
      );
      expect(failedBody).toMatchObject({
        status: 'FAILED',
        failureCode: 'transcode_failed',
        retryable: true,
      });
      for (const text of [
        JSON.stringify(res.body),
        JSON.stringify(failedBody),
      ]) {
        expect(text).not.toMatch(
          /vsrc|uploadId|internalError|Conversion|secret|9210/,
        );
      }
      // a public video has no share token in its view
      const pub = await seed();
      expect(
        (await get(w.staff, w.shop.id, pub.id).expect(200)).body.shareToken,
      ).toBeNull();
    });

    it("S30 AS-42: a VIEWER may read; another shop's video, an unknown id and a non-member are one 404", async () => {
      const mine = await seed();
      const foreign = await seed({}, w.otherShop, w.otherOwner);
      await get(w.viewer, w.shop.id, mine.id).expect(200);
      const answers = [
        await get(w.staff, w.shop.id, foreign.id).expect(404),
        await get(w.staff, w.shop.id, randomUUID()).expect(404),
        await get(w.outsider, w.shop.id, mine.id).expect(404),
        await get(w.outsider, w.otherShop.id, foreign.id).expect(404),
      ];
      for (const a of answers)
        expect(stable(a.body)).toEqual(stable(answers[0].body));
      expect(answers[0].body.code).toBe('video_not_found');
    });

    it('S30 AS-42: progress reports the stage and the counts of the tasks', async () => {
      t.encoder!.install();
      const v = await t.processingVideo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        source: fakeVideo(),
      });
      const before = videoOwnerSchema.parse(
        (await get(w.staff, w.shop.id, v.id).expect(200)).body,
      );
      expect(before.progress).toEqual({
        stage: 'probe',
        tasksDone: 0,
        tasksTotal: 1,
      });
      await t.queue.wave();
      const mid = videoOwnerSchema.parse(
        (await get(w.staff, w.shop.id, v.id).expect(200)).body,
      );
      expect(mid.progress.tasksTotal).toBe(8);
      expect(mid.progress.tasksDone).toBe(1);
      await t.runWaves();
      const done = videoOwnerSchema.parse(
        (await get(w.staff, w.shop.id, v.id).expect(200)).body,
      );
      expect(done.status).toBe('READY');
      expect(done.progress.tasksDone).toBe(done.progress.tasksTotal);
    });
  });

  describe('S30 US4: list', () => {
    it('S30 AS-43: 45 videos in pages of 20 with a cursor: every video once even when new ones arrive between pages, DELETED and other shops never', async () => {
      const base = t.clock.now().getTime();
      const ids: string[] = [];
      for (let i = 0; i < 45; i++)
        ids.push((await seed({ createdAt: new Date(base + i * 1000) })).id);
      await seed({ status: 'DELETED', createdAt: new Date(base + 500) });
      await seed({}, w.otherShop, w.otherOwner);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 4; page++) {
        const res = await list(
          w.staff,
          w.shop.id,
          `?limit=20&status=READY${cursor ? `&cursor=${cursor}` : ''}`,
        ).expect(200);
        const body = videoListSchema.parse(res.body);
        seen.push(...body.items.map((i) => i.id));
        if (page === 0) {
          expect(body.items).toHaveLength(20);
          await seed({ createdAt: new Date(base + 99_000) }); // arrives while the reader is on page one
        }
        cursor = body.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      expect(seen).toHaveLength(45);
      expect(new Set(seen).size).toBe(45);
      expect(seen).toEqual([...ids].reverse()); // newest first, ties by id
    });

    it('S30 AS-43: the default limit is 20 and the maximum 50; bad limits, a malformed cursor and a cursor of another shop or filter are 400', async () => {
      for (let i = 0; i < 25; i++)
        await seed({ createdAt: new Date(t.clock.nowMs() + i) });
      expect(
        videoListSchema.parse((await list(w.staff, w.shop.id).expect(200)).body)
          .items,
      ).toHaveLength(20);
      await list(w.staff, w.shop.id, '?limit=50').expect(200);
      for (const bad of ['?limit=51', '?limit=0', '?limit=x', '?status=BOGUS'])
        expect(
          (await list(w.staff, w.shop.id, bad).expect(400)).body.code,
        ).toBe('validation_failed');
      const first = videoListSchema.parse(
        (await list(w.staff, w.shop.id, '?limit=5').expect(200)).body,
      );
      const cursor = first.nextCursor!;
      for (const bad of [
        'garbage',
        Buffer.from('{"c":"x"}').toString('base64url'),
        Buffer.from('not json').toString('base64url'),
      ])
        expect(
          (await list(w.staff, w.shop.id, `?cursor=${bad}`).expect(400)).body
            .code,
        ).toBe('invalid_cursor');
      // issued for this shop and no filter: refused for another filter and for another shop
      expect(
        (
          await list(
            w.staff,
            w.shop.id,
            `?cursor=${cursor}&status=READY`,
          ).expect(400)
        ).body.code,
      ).toBe('invalid_cursor');
      expect(
        (
          await list(w.otherOwner, w.otherShop.id, `?cursor=${cursor}`).expect(
            400,
          )
        ).body.code,
      ).toBe('invalid_cursor');
      await list(w.staff, w.shop.id, `?cursor=${cursor}`).expect(200);
    });

    it("S30 AS-43: only the shop's own rows are ever returned and a VIEWER may list", async () => {
      const mine = await seed();
      await seed({}, w.otherShop, w.otherOwner);
      const body = videoListSchema.parse(
        (await list(w.viewer, w.shop.id).expect(200)).body,
      );
      expect(body.items.map((i) => i.id)).toEqual([mine.id]);
      await list(w.outsider, w.shop.id).expect(404);
    });
  });

  describe('S30 US4: edit and link', () => {
    it('S30 AS-44: a field change bumps the version without a history row; a stale version is 409 with the current one', async () => {
      const v = await seed({ version: 3 });
      const before = (await t.history(v.id)).length;
      const ok = await patch(w.staff, w.shop.id, v.id, {
        title: 'Renamed',
        expectedVersion: 3,
      }).expect(200);
      expect(videoOwnerSchema.parse(ok.body)).toMatchObject({
        title: 'Renamed',
        version: 4,
      });
      expect((await t.history(v.id)).length).toBe(before);
      const stale = await patch(w.staff, w.shop.id, v.id, {
        title: 'Late',
        expectedVersion: 2,
      }).expect(409);
      expect(stale.body).toMatchObject({
        code: 'version_conflict',
        currentVersion: 4,
      });
      expect((await row(v.id)).title).toBe('Renamed');
    });

    it('S30 AS-44: two edits with the same expected version: one 200, one 409', async () => {
      const v = await seed({ version: 4 });
      const answers = await Promise.all([
        patch(w.staff, w.shop.id, v.id, { title: 'A', expectedVersion: 4 }),
        patch(w.owner, w.shop.id, v.id, { title: 'B', expectedVersion: 4 }),
      ]);
      expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
      expect((await row(v.id)).version).toBe(5);
    });

    it('S30 AS-44: visibility, unknown fields, an empty change and a bad title are 400; DELETED is 404, EXPIRED 409 upload_expired', async () => {
      const v = await seed();
      for (const body of [
        { visibility: 'public', expectedVersion: 1 },
        { title: 'x', status: 'READY', expectedVersion: 1 },
        { expectedVersion: 1 },
        { title: '', expectedVersion: 1 },
        { title: 'x' },
      ])
        expect(
          (await patch(w.staff, w.shop.id, v.id, body).expect(400)).body.code,
        ).toBe('validation_failed');
      const deleted = await seed({ status: 'DELETED' });
      const expired = await seed({ status: 'EXPIRED', outputs: undefined });
      await patch(w.staff, w.shop.id, deleted.id, {
        title: 'x',
        expectedVersion: 1,
      }).expect(404);
      expect(
        (
          await patch(w.staff, w.shop.id, expired.id, {
            title: 'x',
            expectedVersion: 1,
          }).expect(409)
        ).body.code,
      ).toBe('upload_expired');
      await patch(w.viewer, w.shop.id, v.id, {
        title: 'x',
        expectedVersion: 1,
      }).expect(403);
    });

    it('S30 AS-45: linking follows the product rules; a foreign or unknown product is 404, an archived one 409, null unlinks', async () => {
      const v = await seed();
      const product = await t.product(w.shop.id);
      const foreign = await t.product(w.otherShop.id);
      const archived = await t.product(w.shop.id, { status: 'ARCHIVED' });
      const read = jest.spyOn(
        t.app.get(ProductQueryService),
        'getProductsByIds',
      );
      const linked = videoOwnerSchema.parse(
        (
          await patch(w.staff, w.shop.id, v.id, {
            productId: product.id,
            expectedVersion: 1,
          }).expect(200)
        ).body,
      );
      expect(linked).toMatchObject({ productId: product.id, version: 2 });
      expect(read).toHaveBeenCalledTimes(1);
      const a = await patch(w.staff, w.shop.id, v.id, {
        productId: foreign.id,
        expectedVersion: 2,
      }).expect(404);
      const b = await patch(w.staff, w.shop.id, v.id, {
        productId: randomUUID(),
        expectedVersion: 2,
      }).expect(404);
      expect(a.body.code).toBe('product_not_found');
      expect(stable(a.body)).toEqual(stable(b.body));
      expect(
        (
          await patch(w.staff, w.shop.id, v.id, {
            productId: archived.id,
            expectedVersion: 2,
          }).expect(409)
        ).body.code,
      ).toBe('product_archived');
      const unlinked = videoOwnerSchema.parse(
        (
          await patch(w.staff, w.shop.id, v.id, {
            productId: null,
            expectedVersion: 2,
          }).expect(200)
        ).body,
      );
      expect(unlinked.productId).toBeNull();
    });

    it('S30 AS-45: an 11th video on a product is 409 product_video_limit; two links at once on 9 give one success', async () => {
      const product = await t.product(w.shop.id);
      for (let i = 0; i < 9; i++) await seed({ productId: product.id });
      await seed({ productId: product.id, status: 'DELETED' }); // deleted ones do not count
      const a = await seed();
      const b = await seed();
      const answers = await Promise.all([
        patch(w.staff, w.shop.id, a.id, {
          productId: product.id,
          expectedVersion: 1,
        }),
        patch(w.owner, w.shop.id, b.id, {
          productId: product.id,
          expectedVersion: 1,
        }),
      ]);
      expect(answers.map((x) => x.status).sort()).toEqual([200, 409]);
      expect(answers.find((x) => x.status === 409)!.body.code).toBe(
        'product_video_limit',
      );
      expect(
        Number(
          (
            await t.sql<{ n: string }>(
              `SELECT count(*) AS n FROM "Video" WHERE "productId" = :p AND "status" <> 'DELETED'`,
              { p: product.id },
            )
          )[0].n,
        ),
      ).toBe(10);
    });
  });

  describe('S30 US4: retry', () => {
    it('S30 AS-46: a failed video resumes from its last finished task, with messages after the commit, and then finishes', async () => {
      t.encoder!.install();
      await t.encoder!.behave([{ match: 'scale=1280:720', action: 'fail' }]);
      const v = await t.processingVideo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        source: fakeVideo(),
      });
      await t.runWaves();
      expect((await row(v.id)).failureCode).toBe('transcode_failed');
      const states = Object.fromEntries(
        (await t.tasks(v.id)).map((x) => [x.name, x.status]),
      );
      expect(states).toMatchObject({
        probe: 'DONE',
        poster: 'DONE',
        'transcode:240': 'DONE',
        'transcode:720': 'FAILED',
        package: 'CANCELLED',
      });
      await t.encoder!.reset();

      const res = await retry(w.staff, w.shop.id, v.id).expect(202);
      expect(res.body).toEqual({ status: 'PROCESSING' });
      const after = Object.fromEntries(
        (await t.tasks(v.id)).map((x) => [x.name, [x.status, x.attempts]]),
      );
      expect(after['probe']).toEqual(['DONE', 1]); // finished work is kept
      expect(after['transcode:720']).toEqual(['QUEUED', 0]);
      expect(after['package']).toEqual(['PENDING', 0]);
      expect(
        t.queue.pending().map((m) => (m.body as { task: string }).task),
      ).toEqual(['transcode:720']);
      expect(await row(v.id)).toMatchObject({
        status: 'PROCESSING',
        failureCode: null,
        retryCount: 1,
      });
      await t.runWaves();
      expect((await row(v.id)).status).toBe('READY');
    });

    it('S30 AS-46: a non-retryable failure, the wrong state, a purged source and the fourth retry are 409 with their own codes', async () => {
      const permanent = await seed({
        status: 'FAILED',
        failureCode: 'not_a_video',
        outputs: undefined,
      });
      const ready = await seed();
      const purged = await seed({
        status: 'FAILED',
        failureCode: 'task_timeout',
        outputs: undefined,
        objectsPurgedAt: t.clock.now(),
      });
      const tired = await seed({
        status: 'FAILED',
        failureCode: 'task_timeout',
        outputs: undefined,
        retryCount: 3,
      });
      const answers = {
        permanent: (await retry(w.staff, w.shop.id, permanent.id).expect(409))
          .body,
        ready: (await retry(w.staff, w.shop.id, ready.id).expect(409)).body,
        purged: (await retry(w.staff, w.shop.id, purged.id).expect(409)).body,
        tired: (await retry(w.staff, w.shop.id, tired.id).expect(409)).body,
      };
      expect(answers.permanent.code).toBe('not_retryable');
      expect(answers.ready).toMatchObject({
        code: 'invalid_state',
        videoStatus: 'READY',
      });
      expect(answers.purged.code).toBe('source_purged');
      expect(answers.tired.code).toBe('retry_limit');
      await retry(w.viewer, w.shop.id, tired.id).expect(403);
    });

    it('S30 AS-46: two retries at once: one 202 and one 409 invalid_state', async () => {
      const failed = await seed({
        status: 'FAILED',
        failureCode: 'storage_unavailable',
        outputs: undefined,
      });
      const answers = await Promise.all([
        retry(w.staff, w.shop.id, failed.id),
        retry(w.owner, w.shop.id, failed.id),
      ]);
      expect(answers.map((a) => a.status).sort()).toEqual([202, 409]);
      expect(answers.find((a) => a.status === 409)!.body.code).toBe(
        'invalid_state',
      );
      expect((await row(failed.id)).retryCount).toBe(1);
    });
  });

  describe('S30 US4: delete', () => {
    it('S30 AS-47: 204, the row is DELETED with a history row and one video.deleted, open tasks are CANCELLED and every read stops at once', async () => {
      t.encoder!.install();
      const v = await t.processingVideo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        source: fakeVideo(),
      });
      await t.queue.wave(); // probe done, the graph is stored
      await remove(w.staff, w.shop.id, v.id).expect(204);
      expect(await row(v.id)).toMatchObject({ status: 'DELETED', version: 2 });
      expect((await t.history(v.id)).map((h) => h.toStatus)).toEqual([
        'PROCESSING',
        'DELETED',
      ]);
      const events = await t.outbox('video.deleted');
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        videoId: v.id,
        shopId: w.shop.id,
        videoVersion: 2,
      });
      const states = (await t.tasks(v.id))
        .filter((x) => x.name !== 'probe')
        .map((x) => x.status);
      expect(new Set(states)).toEqual(new Set(['CANCELLED']));
      await get(w.staff, w.shop.id, v.id).expect(404);
      expect(
        videoListSchema.parse((await list(w.staff, w.shop.id).expect(200)).body)
          .items,
      ).toHaveLength(0);
      await t.http().get(`/api/videos/${v.id}/playback`).expect(404);
      // second delete, a VIEWER, and no credentials
      await remove(w.staff, w.shop.id, v.id).expect(404);
      const other = await seed();
      await remove(w.viewer, w.shop.id, other.id).expect(403);
      await t
        .http()
        .delete(`/api/shops/${w.shop.id}/videos/${other.id}`)
        .expect(401);
      expect((await row(other.id)).status).toBe('READY');
    });

    it('S30 AS-47: deleting an uploading video aborts its multipart upload after the commit', async () => {
      t.partSize.value = MIN_PART_SIZE;
      const started = videoStartResponseSchema.parse(
        (
          await t
            .as(w.staff)
            .post(`/api/shops/${w.shop.id}/videos`)
            .send({
              title: 't',
              sizeBytes: MIN_PART_SIZE + 10,
              contentType: 'video/mp4',
              visibility: 'public',
            })
            .expect(201)
        ).body,
      );
      await t.uploadParts(started, { only: [1] });
      const r = await row(started.videoId);
      expect(await t.storage.listParts(r.sourceKey, r.uploadId)).not.toBeNull();
      await remove(w.staff, w.shop.id, started.videoId).expect(204);
      expect(await t.storage.listParts(r.sourceKey, r.uploadId)).toBeNull();
    }, 60_000);
  });

  describe('S30 US4: tenant isolation', () => {
    it("S30 AS-48: every seller route with another shop's video, and as a non-member, answers one 404 and changes nothing", async () => {
      const foreign = await seed({}, w.otherShop, w.otherOwner);
      const failed = await seed(
        { status: 'FAILED', failureCode: 'task_timeout', outputs: undefined },
        w.otherShop,
        w.otherOwner,
      );
      const before = JSON.stringify(
        await t.sql(
          `SELECT "id","status","version","title","updatedAt" FROM "Video" ORDER BY "id"`,
        ),
      );
      const calls = (user: TestUser, shopId: string) => [
        () => get(user, shopId, foreign.id),
        () =>
          t.as(user).get(`/api/shops/${shopId}/videos/${foreign.id}/upload`),
        () =>
          t
            .as(user)
            .post(`/api/shops/${shopId}/videos/${foreign.id}/complete`)
            .send({ parts: [{ partNumber: 1, etag: 'x' }] }),
        () =>
          patch(user, shopId, foreign.id, { title: 'x', expectedVersion: 1 }),
        () => retry(user, shopId, failed.id),
        () => remove(user, shopId, foreign.id),
      ];
      const answers = [
        ...(await Promise.all(calls(w.staff, w.shop.id).map((c) => c()))), // other shop's video under my path
        ...(await Promise.all(calls(w.staff, w.otherShop.id).map((c) => c()))), // as a non-member under its path
      ];
      for (const a of answers) {
        expect(a.status).toBe(404);
        expect(stable(a.body)).toEqual(stable(answers[0].body));
      }
      expect(
        JSON.stringify(
          await t.sql(
            `SELECT "id","status","version","title","updatedAt" FROM "Video" ORDER BY "id"`,
          ),
        ),
      ).toBe(before);
      expect(t.queue.pending()).toHaveLength(0);
    });
  });
});

export type { VideoOwner };
