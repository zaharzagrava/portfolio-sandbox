import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { v7 as uuidv7 } from 'uuid';
import { ProductDeleted } from '@app/domains/catalog';
import { ShopDeleted, ShopStatusChanged } from '@app/domains/tenancy';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { InvalidScheduleError, JobsService } from '@app/infrastructure/jobs';
import { getJobTypeDeclaration } from '@app/infrastructure/jobs/job-type-registry';
import { JobRegistry } from '@app/infrastructure/jobs/job-registry.service';
import { validateDeclaration } from '@app/infrastructure/projections/consumer-declaration';
import { PermanentError } from '@app/infrastructure/projections/errors';
import { videoEventSchemas } from '@marketplace-sandbox/contracts';
import { sourceKey } from './domain/delivery-paths';
import { VideoStore, type VideoOutputs } from './domain/video-ports';
import {
  VideoProductDeletedProjector,
  VideoShopDeletedProjector,
  VideoShopStatusProjector,
} from './infra/video-consumers';
import { PgVideoRepository } from './infra/pg-video-repository';
import { VideoMaintenanceJobs } from './video-maintenance.jobs';
import { VideoProjectorModule } from './video-projector.module';
import { fakeVideo } from './testing/test-videos';
import {
  MIN_PART_SIZE,
  createVideoApp,
  type VideoTestApp,
  type VideoWorld,
} from './testing/video-app';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
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

describe('Video lifecycle jobs and consumers', () => {
  let t: VideoTestApp;
  let w: VideoWorld;
  let store: VideoStore;

  beforeAll(async () => {
    t = await createVideoApp({
      worker: true,
      extraImports: [VideoProjectorModule],
    });
    store = t.app.get(VideoStore);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    t.encoder!.uninstall();
    await t.reset();
    w = await t.world();
    t.encoder!.install();
  });
  afterEach(() => {
    t.encoder!.uninstall();
    jest.restoreAllMocks();
  });

  const ago = (ms: number) => new Date(t.clock.nowMs() - ms);
  const row = async (id: string) => (await t.row(id))!;
  /**
   * The registry that discovers every `@JobHandler` of the app, built the way `JobsWorkerModule` does but without its
   * polling loop (which would fire the schedules by itself while a test runs).
   */
  let registry: JobRegistry;
  const jobRegistry = () => {
    if (!registry) {
      registry = new JobRegistry(
        t.app.get(DiscoveryService, { strict: false }),
        t.app.get(MetadataScanner, { strict: false }),
        t.app.get(Reflector, { strict: false }),
      );
      registry.onModuleInit();
    }
    return registry;
  };
  /** Runs a job the way the worker does: through the registry that discovered its `@JobHandler`. */
  const runJob = (type: string) =>
    jobRegistry()
      .get(type)!
      .run(
        {},
        {
          jobId: randomUUID(),
          attempt: 1,
          maxAttempts: 3,
          isLastAttempt: false,
          heartbeat: async () => undefined,
          signal: new AbortController().signal,
        },
      );
  const seed = (
    over: Record<string, unknown> = {},
    shop = w.shop,
    user = w.staff,
  ) => t.video({ shopId: shop.id, uploaderId: user.id, ...over });
  const pending = () =>
    t.queue
      .pending()
      .map(
        (m) =>
          `${(m.body as { videoId: string }).videoId}:${(m.body as { task: string }).task}`,
      )
      .sort();
  const complete = (id: string) =>
    t
      .as(w.staff)
      .post(`/api/shops/${w.shop.id}/videos/${id}/complete`)
      .send({ parts: [{ partNumber: 1, etag: 'x' }] });
  /** A video row whose multipart upload really exists in storage. */
  const withUpload = async (over: Record<string, unknown> = {}) => {
    const id = uuidv7();
    const { uploadId } = await t.storage.startMultipartUpload(
      sourceKey(id),
      'video/mp4',
    );
    await seed({ id, uploadId, ...over });
    return { id, uploadId, key: sourceKey(id) };
  };

  describe('S30 US5: expire unfinished uploads', () => {
    it('S30 AS-49: uploads past their 24 hours become EXPIRED once with their multipart upload aborted; younger ones, and the exact boundary second, behave', async () => {
      const old = await withUpload({
        createdAt: ago(DAY + 1000),
        sessionExpiresAt: ago(1000),
      });
      const edge = await withUpload({
        createdAt: ago(DAY),
        sessionExpiresAt: ago(0),
      }); // exactly 24 h: over
      const young = await withUpload({
        createdAt: ago(23 * HOUR),
        sessionExpiresAt: new Date(t.clock.nowMs() + HOUR),
      });
      const justBefore = await withUpload({
        createdAt: ago(DAY - 1),
        sessionExpiresAt: new Date(t.clock.nowMs() + 1),
      });

      await Promise.all([
        runJob('media.video-expire-uploads'),
        runJob('media.video-expire-uploads'),
      ]);
      await runJob('media.video-expire-uploads');
      for (const v of [old, edge]) {
        expect((await row(v.id)).status).toBe('EXPIRED');
        expect(
          (await t.history(v.id)).map((h) => `${h.fromStatus}>${h.toStatus}`),
        ).toEqual(['null>UPLOADING', 'UPLOADING>EXPIRED']);
        expect(await t.storage.listParts(v.key, v.uploadId)).toBeNull(); // aborted
        expect((await complete(v.id).expect(409)).body.code).toBe(
          'upload_expired',
        );
      }
      for (const v of [young, justBefore]) {
        expect((await row(v.id)).status).toBe('UPLOADING');
        expect(await t.storage.listParts(v.key, v.uploadId)).not.toBeNull();
      }
      expect(
        t.metrics.count('video_status_transitions_total{UPLOADING,EXPIRED}'),
      ).toBe(2);
    });
  });

  describe('S30 US5: recover stuck work', () => {
    it('S30 AS-50: a lost lease, a lost message, a stuck upload and a lost fan-in are each recovered once; repeated and concurrent sweeps add nothing', async () => {
      // (a) a worker took the probe and died: its lease runs out
      const a = await t.processingVideo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        source: fakeVideo(),
      });
      // (b) the probe message was lost between the commit and the send
      const b = await t.processingVideo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        source: fakeVideo(),
      });
      // (d) every task but publish is done, publish was never queued
      const d = await t.processingVideo({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        source: fakeVideo(),
      });
      t.queue.take();
      await store.tasks.claim({
        videoId: a.id,
        name: 'probe',
        now: t.clock.now(),
        leaseUntil: new Date(t.clock.nowMs() + 5 * MINUTE),
        maxAttempts: 3,
      });
      // run d to just before publish with its own messages
      await t.queue.enqueue('video-transcode', {
        videoId: d.id,
        task: 'probe',
      });
      await t.queue.wave();
      while (!(
        t.queue.pending().length === 1 &&
        (t.queue.pending()[0].body as { task: string }).task === 'publish'
      )) {
        if (t.queue.pending().length === 0)
          throw new Error('d never reached publish');
        await t.queue.wave();
      }
      t.queue.take();
      await t.sql(
        `UPDATE "VideoTask" SET "status" = 'PENDING', "lastSentAt" = NULL WHERE "videoId" = :id AND "name" = 'publish'`,
        { id: d.id },
      );
      // (c) a crash after the claim: assembled upload, status UPLOADED
      t.partSize.value = MIN_PART_SIZE;
      const started = (
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
      ).body;
      await t.uploadParts(started);
      await store.tx(({ video }) =>
        video.claimUploaded(
          started.videoId,
          { type: 'user', id: w.staff.id },
          t.clock.now(),
        ),
      );

      t.clock.advance(6 * MINUTE);
      t.queue.take();
      await runJob('media.video-requeue-stuck');
      expect(pending()).toEqual(
        [
          `${a.id}:probe`,
          `${b.id}:probe`,
          `${started.videoId}:probe`,
          `${d.id}:publish`,
        ].sort(),
      );
      expect((await row(started.videoId)).status).toBe('PROCESSING');
      for (const kind of ['lease', 'queued', 'uploaded', 'fanin'])
        expect(t.metrics.count(`video_stuck_recovered_total{${kind}}`)).toBe(1);

      // a repeated sweep and two concurrent ones add no second message
      await Promise.all([
        runJob('media.video-requeue-stuck'),
        runJob('media.video-requeue-stuck'),
      ]);
      expect(pending()).toHaveLength(4);

      // everything finishes, and a duplicate for a finished task is a stale no-op
      await t.runWaves();
      for (const id of [a.id, b.id, d.id])
        expect((await row(id)).status).toBe('READY');
      // the real upload holds bytes that are no video: it was driven on and then rejected by the probe, as it should be
      expect(await row(started.videoId)).toMatchObject({
        status: 'FAILED',
        failureCode: 'not_a_video',
      });
      const stale = t.metrics.count('video_task_total{probe,stale}');
      await t.queue.deliver({ videoId: a.id, task: 'probe' });
      expect(t.metrics.count('video_task_total{probe,stale}')).toBe(stale + 1);
    }, 120_000);

    it('S30 AS-51: a video in PROCESSING for more than 6 hours fails as processing_timeout (retryable), open tasks cancelled, one video.failed', async () => {
      const over = await seed({
        status: 'PROCESSING',
        createdAt: ago(6 * HOUR + 1000),
      });
      const under = await seed({
        status: 'PROCESSING',
        createdAt: ago(6 * HOUR - 1000),
      });
      for (const v of [over, under])
        await t.sql(
          `INSERT INTO "VideoTask" ("videoId","name","dependsOn","status","createdAt","updatedAt") VALUES (:id,'probe','{}','RUNNING',now(),now())`,
          { id: v.id },
        );
      await runJob('media.video-requeue-stuck');
      expect(await row(over.id)).toMatchObject({
        status: 'FAILED',
        failureCode: 'processing_timeout',
      });
      expect((await t.tasks(over.id))[0].status).toBe('CANCELLED');
      expect((await row(under.id)).status).toBe('PROCESSING');
      const failed = await t.outbox('video.failed');
      expect(failed).toHaveLength(1);
      expect(
        videoEventSchemas['video.failed'].parse(failed[0].payload),
      ).toMatchObject({ videoId: over.id, failureCode: 'processing_timeout' });
      const retry = await t
        .as(w.staff)
        .post(`/api/shops/${w.shop.id}/videos/${over.id}/retry`);
      expect(retry.status).toBe(202); // processing_timeout is retryable
    });
  });

  describe('S30 US5: purge', () => {
    const put = (key: string) =>
      t.storage.put(key, Buffer.from('x'), 'application/octet-stream');
    const objectsOf = async (id: string) =>
      (
        await Promise.all(
          ['vsrc/', 'p/', 'u/'].map((p) => t.storage.list(`${p}${id}/`)),
        )
      ).flat().length;
    const stored = async (over: Record<string, unknown>) => {
      const v = await seed(over);
      await put(v.sourceKey);
      await put(`p/${v.id}/master.m3u8`);
      await put(`u/${v.id}/master.m3u8`);
      await put(`p/${v.id}/r/720/a1/seg_00000.ts`);
      return v;
    };

    it('S30 AS-52: DELETED, EXPIRED and week-old FAILED videos lose their files; READY, young FAILED and other states keep theirs; the edge is asked about a deleted public video', async () => {
      const deleted = await stored({ status: 'DELETED' });
      const deletedUnlisted = await stored({
        status: 'DELETED',
        visibility: 'unlisted',
      });
      const expired = await stored({ status: 'EXPIRED' });
      const oldFailed = await stored({
        status: 'FAILED',
        failureCode: 'task_timeout',
        createdAt: ago(9 * DAY),
        updatedAt: ago(8 * DAY),
      });
      const youngFailed = await stored({
        status: 'FAILED',
        failureCode: 'task_timeout',
        updatedAt: ago(6 * DAY),
      });
      const ready = await stored({ status: 'READY', outputs: OUTPUTS });
      const uploading = await stored({ status: 'UPLOADING' });
      const missing = await seed({ status: 'DELETED' }); // no object at all: not an error

      await runJob('media.video-purge');
      for (const v of [deleted, deletedUnlisted, expired, oldFailed, missing]) {
        expect(await objectsOf(v.id)).toBe(0);
        expect((await row(v.id)).objectsPurgedAt).not.toBeNull();
      }
      for (const v of [youngFailed, ready, uploading]) {
        expect(await objectsOf(v.id)).toBeGreaterThan(0);
        expect((await row(v.id)).objectsPurgedAt).toBeNull();
      }
      const edge = t.edge as { invalidations: string[][] };
      expect(edge.invalidations.flat().sort()).toEqual(
        [`/p/${deleted.id}/*`, `/p/${missing.id}/*`].sort(),
      );
      expect((await row(deleted.id)).edgePurgedAt).not.toBeNull();
      expect((await row(deletedUnlisted.id)).edgePurgedAt).toBeNull();
      // a retry of the purged failed video says so
      const retry = await t
        .as(w.staff)
        .post(`/api/shops/${w.shop.id}/videos/${oldFailed.id}/retry`)
        .expect(409);
      expect(retry.body.code).toBe('source_purged');
      // idempotent: a second run changes and asks for nothing
      await runJob('media.video-purge');
      expect(edge.invalidations.flat()).toHaveLength(2);
    });

    it('S30 AS-52: a failing edge request does not stop the deletion and is repeated on the next run; a failing storage call for one video does not stop the others', async () => {
      const a = await stored({ status: 'DELETED' });
      const b = await stored({ status: 'DELETED' });
      (
        t.edge as { failInvalidations(e: Error | undefined): void }
      ).failInvalidations(new Error('edge down'));
      await runJob('media.video-purge');
      expect(await objectsOf(a.id)).toBe(0);
      expect(await objectsOf(b.id)).toBe(0);
      expect((await row(a.id)).edgePurgedAt).toBeNull();
      (
        t.edge as { failInvalidations(e: Error | undefined): void }
      ).failInvalidations(undefined);
      await runJob('media.video-purge');
      expect((await row(a.id)).edgePurgedAt).not.toBeNull();
      expect((await row(b.id)).edgePurgedAt).not.toBeNull();

      const c = await stored({ status: 'DELETED' });
      const d = await stored({ status: 'DELETED' });
      const real = t.storage.deletePrefix.bind(t.storage);
      jest
        .spyOn(t.storage, 'deletePrefix')
        .mockImplementation((prefix, options) => {
          if (prefix.includes(c.id))
            return Promise.reject(new Error('storage hiccup'));
          return real(prefix, options);
        });
      await runJob('media.video-purge');
      expect(await objectsOf(d.id)).toBe(0);
      expect((await row(c.id)).objectsPurgedAt).toBeNull();
      jest.restoreAllMocks();
      await runJob('media.video-purge');
      expect(await objectsOf(c.id)).toBe(0);
    });

    it('S30 AS-52: one run handles at most 200 videos', async () => {
      for (let i = 0; i < 205; i++)
        await seed({ status: 'DELETED', visibility: 'unlisted' });
      await runJob('media.video-purge');
      const left = Number(
        (
          await t.sql<{ n: string }>(
            `SELECT count(*) AS n FROM "Video" WHERE "objectsPurgedAt" IS NULL`,
          )
        )[0].n,
      );
      expect(left).toBe(5);
      await runJob('media.video-purge');
      expect(
        Number(
          (
            await t.sql<{ n: string }>(
              `SELECT count(*) AS n FROM "Video" WHERE "objectsPurgedAt" IS NULL`,
            )
          )[0].n,
        ),
      ).toBe(0);
    }, 120_000);
  });

  describe('S30 US5: consumers', () => {
    const productDeleted = (
      productId: string,
      shopId: string,
      version = 2,
    ): EventEnvelope =>
      ProductDeleted.create(productId, version, {
        productId,
        shopId,
        productVersion: version,
      }) as EventEnvelope;
    const shopDeleted = (shopId: string): EventEnvelope =>
      ShopDeleted.create(shopId, 3, {
        shopId,
        shopVersion: 3,
      }) as EventEnvelope;
    const statusChanged = (
      shopId: string,
      to: string,
      shopVersion: number,
    ): EventEnvelope =>
      ShopStatusChanged.create(shopId, shopVersion, {
        shopId,
        from: to === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED',
        to,
        shopVersion,
      } as never) as EventEnvelope;

    it('S30 declaration: the three consumers are valid S53 declarations with natural idempotency', () => {
      const consumers = [
        t.app.get(VideoProductDeletedProjector),
        t.app.get(VideoShopDeletedProjector),
        t.app.get(VideoShopStatusProjector),
      ];
      for (const c of consumers) {
        expect(() => validateDeclaration(c)).not.toThrow();
        expect(c.idempotency).toBe('natural');
      }
      expect(VideoProjectorModule.projectors).toHaveLength(3);
    });

    it('S30 AS-53: product deleted clears the link and gains a version once; a foreign shopId changes nothing; an invalid payload is refused with no effect', async () => {
      const consumer = t.app.get(VideoProductDeletedProjector);
      const product = await t.product(w.shop.id);
      const a = await seed({ productId: product.id });
      const b = await seed({ productId: product.id });
      const bystander = await seed({});
      await consumer.project([productDeleted(product.id, w.otherShop.id)]); // another shop's id: nothing
      expect((await row(a.id)).productId).toBe(product.id);
      await consumer.project([productDeleted(product.id, w.shop.id)]);
      for (const v of [a, b])
        expect(await row(v.id)).toMatchObject({ productId: null, version: 2 });
      expect((await row(bystander.id)).version).toBe(1);
      await consumer.project([productDeleted(product.id, w.shop.id)]); // a second delivery
      expect((await row(a.id)).version).toBe(2);
      await expect(
        consumer.project([
          {
            ...productDeleted(product.id, w.shop.id),
            payload: { productId: 'x' },
          } as never,
        ]),
      ).rejects.toBeInstanceOf(PermanentError);
      const notUuid = productDeleted(randomUUID(), w.shop.id);
      (notUuid.payload as { productId: string }).productId = 'not-a-uuid';
      await expect(consumer.project([notUuid])).rejects.toBeInstanceOf(
        PermanentError,
      );
    });

    it("S30 AS-54: a deleted shop's 450 videos are deleted in batches of 50, one video.deleted each, open tasks cancelled; a replay changes nothing", async () => {
      const consumer = t.app.get(VideoShopDeletedProjector);
      const statuses = [
        'UPLOADING',
        'PROCESSING',
        'READY',
        'FAILED',
        'EXPIRED',
        'DELETED',
      ] as const;
      const ids: string[] = [];
      for (let i = 0; i < 450; i++) {
        const status = statuses[i % statuses.length];
        ids.push((await seed({ status })).id);
      }
      const processing = ids
        .filter((_, i) => statuses[i % statuses.length] === 'PROCESSING')
        .slice(0, 3);
      for (const id of processing)
        await t.sql(
          `INSERT INTO "VideoTask" ("videoId","name","dependsOn","status","createdAt","updatedAt") VALUES (:id,'probe','{}','QUEUED',now(),now())`,
          { id },
        );
      const other = await seed({}, w.otherShop, w.otherOwner);
      const batches = jest.spyOn(
        PgVideoRepository.prototype,
        'deleteShopBatch',
      );

      await consumer.project([shopDeleted(w.shop.id)]);
      // 375 live videos: seven batches of 50 and a last one of 25, each its own transaction
      expect(batches.mock.calls.map((c) => c[1])).toEqual(Array(8).fill(50));
      const remaining = Number(
        (
          await t.sql<{ n: string }>(
            `SELECT count(*) AS n FROM "Video" WHERE "shopId" = :s AND "status" <> 'DELETED'`,
            { s: w.shop.id },
          )
        )[0].n,
      );
      expect(remaining).toBe(0);
      const live = ids.length - ids.length / statuses.length; // the DELETED ones were already gone
      expect(await t.outbox('video.deleted')).toHaveLength(live);
      for (const id of processing)
        expect((await t.tasks(id))[0].status).toBe('CANCELLED');
      expect((await row(other.id)).status).toBe('UPLOADING');
      const before = JSON.stringify(
        await t.sql(`SELECT "id","version" FROM "Video" ORDER BY "id"`),
      );
      await consumer.project([shopDeleted(w.shop.id)]);
      expect(
        JSON.stringify(
          await t.sql(`SELECT "id","version" FROM "Video" ORDER BY "id"`),
        ),
      ).toBe(before);
      expect(await t.outbox('video.deleted')).toHaveLength(live);
      await expect(
        consumer.project([
          { ...shopDeleted(w.shop.id), payload: { shopId: 5 } } as never,
        ]),
      ).rejects.toBeInstanceOf(PermanentError);
    }, 180_000);

    it('S30 AS-55: shop status out of order: v5 SUSPENDED then v4 ACTIVE stays suspended; duplicates and no-video shops; invalid payloads; playback reacts', async () => {
      const consumer = t.app.get(VideoShopStatusProjector);
      const v = await seed({
        status: 'READY',
        outputs: OUTPUTS,
        durationSec: 6,
        width: 1280,
        height: 720,
      });
      const state = async () =>
        (
          await t.sql<{ suspended: boolean; shopVersion: number }>(
            `SELECT "suspended","shopVersion" FROM "VideoShopState" WHERE "shopId" = :s`,
            { s: w.shop.id },
          )
        )[0];
      await consumer.project([statusChanged(w.shop.id, 'SUSPENDED', 5)]);
      await consumer.project([statusChanged(w.shop.id, 'ACTIVE', 4)]);
      expect(await state()).toEqual({ suspended: true, shopVersion: 5 });
      await consumer.project([
        statusChanged(w.shop.id, 'SUSPENDED', 5),
        statusChanged(w.shop.id, 'SUSPENDED', 5),
      ]);
      expect(await state()).toEqual({ suspended: true, shopVersion: 5 });
      await t.http().get(`/api/videos/${v.id}/playback`).expect(404);
      await consumer.project([statusChanged(w.shop.id, 'ACTIVE', 6)]);
      expect(await state()).toEqual({ suspended: false, shopVersion: 6 });
      await t.http().get(`/api/videos/${v.id}/playback`).expect(200);
      // a shop with no video still gets its copy
      const empty = await t.world();
      await consumer.project([statusChanged(empty.shop.id, 'SUSPENDED', 2)]);
      expect(
        Number(
          (
            await t.sql<{ n: string }>(
              `SELECT count(*) AS n FROM "VideoShopState" WHERE "shopId" = :s`,
              { s: empty.shop.id },
            )
          )[0].n,
        ),
      ).toBe(1);
      await expect(
        consumer.project([
          {
            ...statusChanged(w.shop.id, 'ACTIVE', 9),
            payload: { shopId: 'nope', to: 'ACTIVE', shopVersion: 9 },
          } as never,
        ]),
      ).rejects.toBeInstanceOf(PermanentError);
      expect(await state()).toEqual({ suspended: false, shopVersion: 6 });
    });
  });

  describe('S30 US5: jobs are declared, scheduled and registered', () => {
    it('S30 S49 follow-up: the three job types are declared with a strict empty payload, scheduled, and run through the job registry', async () => {
      for (const name of [
        'media.video-expire-uploads',
        'media.video-requeue-stuck',
        'media.video-purge',
      ]) {
        const declaration = getJobTypeDeclaration(name as never)!;
        expect(declaration.contract.safeParse({}).success).toBe(true);
        expect(declaration.contract.safeParse({ extra: 1 }).success).toBe(
          false,
        );
        expect(jobRegistry().get(name)).toBeDefined();
        await runJob(name);
      }
      // the schedules are written at start-up; the test cleanup emptied the table since, so start-up runs again
      await t.app.get(VideoMaintenanceJobs).onApplicationBootstrap();
      const names = (
        await t.sql<{ name: string }>(
          `SELECT "name" FROM "JobSchedule" WHERE "name" LIKE 'media.video-%' ORDER BY "name"`,
        )
      ).map((r) => r.name);
      expect(names).toEqual([
        'media.video-expire-uploads',
        'media.video-purge',
        'media.video-requeue-stuck',
      ]);
    });

    it('S30 S49 follow-up: an InvalidScheduleError is caught and logged, any other error is not swallowed; nothing calls JobsService.cancel', async () => {
      const jobs = t.app.get(VideoMaintenanceJobs);
      const service = t.app.get(JobsService);
      jest
        .spyOn(service, 'upsertSchedule')
        .mockRejectedValue(new InvalidScheduleError('cron', 'bad cron'));
      await expect(jobs.onApplicationBootstrap()).resolves.toBeUndefined();
      jest
        .spyOn(service, 'upsertSchedule')
        .mockRejectedValue(new Error('database down'));
      await expect(jobs.onApplicationBootstrap()).rejects.toThrow(
        'database down',
      );
      for (const file of [
        'video-maintenance.jobs.ts',
        'application/video-lifecycle.service.ts',
        'application/video-sweep.service.ts',
        'application/video-purge.service.ts',
      ])
        expect(readFileSync(join(__dirname, file), 'utf8')).not.toMatch(
          /\.cancel\(/,
        );
    });
  });
});

void stable;
