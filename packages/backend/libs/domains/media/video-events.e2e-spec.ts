import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { videoEventSchemas } from '@marketplace-sandbox/contracts';
import { ConfigRules } from '@app/common/config/config-rules';
import { VideoModule as BarrelVideoModule } from '@app/domains/media';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { VideoSweepService } from './application/video-sweep.service';
import { ownerOf } from '../../../db/ownership';
import { STUB } from './testing/stub-encoder';
import { failOutboxInserts } from './testing/outbox-trigger';
import { fakeVideo, textFile } from './testing/test-videos';
import { isProcessGone } from './infra/child-process';
import {
  createVideoApp,
  type VideoTestApp,
  type VideoWorld,
} from './testing/video-app';

const OUTPUTS = {
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
const ROOT = join(__dirname, '../../..');

describe('Video events, observability and configuration', () => {
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
    t.encoder!.install();
  });
  afterEach(() => {
    t.encoder!.uninstall();
    jest.restoreAllMocks();
  });

  const ingest = (source = fakeVideo()) =>
    t.processingVideo({ shopId: w.shop.id, uploaderId: w.staff.id, source });
  const row = async (id: string) => (await t.row(id))!;
  const pendingNames = () =>
    t.queue
      .pending()
      .map((m) => (m.body as { task: string }).task)
      .sort();
  const waveUntil = async (names: string[]) => {
    for (let i = 0; i < 10; i++) {
      if (JSON.stringify(pendingNames()) === JSON.stringify([...names].sort()))
        return;
      await t.queue.wave();
    }
    throw new Error(`never reached ${names.join(',')}`);
  };

  describe('S30 US6: events', () => {
    it('S30 AS-56: video.ready, video.failed and video.deleted carry the envelope and a payload their schema accepts, with a growing videoVersion and no URL, key or token', async () => {
      const ok = await ingest();
      const bad = await ingest(textFile());
      await t.runWaves();
      await t
        .as(w.staff)
        .delete(`/api/shops/${w.shop.id}/videos/${ok.id}`)
        .expect(204);

      const events = await t.outbox();
      const byType = (type: string) => events.filter((e) => e.type === type);
      expect(byType('video.ready')).toHaveLength(1);
      expect(byType('video.failed')).toHaveLength(1);
      expect(byType('video.deleted')).toHaveLength(1);
      for (const e of events) {
        expect(e.envelope).toMatchObject({
          type: e.type,
          version: 1,
          aggregateId: e.payload.videoId,
        });
        expect(e.envelope.eventId).toMatch(/^[0-9a-f-]{36}$/);
        expect(new Date(e.envelope.occurredAt).getTime()).not.toBeNaN();
        videoEventSchemas[e.type as keyof typeof videoEventSchemas].parse(
          e.payload,
        );
        const text = JSON.stringify(e.payload);
        expect(text).not.toMatch(
          /https?:|vsrc|u\/|p\/|uploadId|shareToken|token/i,
        );
      }
      const ready = byType('video.ready')[0].payload;
      const deleted = byType('video.deleted')[0].payload;
      expect(ready.videoId).toBe(ok.id);
      expect(deleted.videoVersion).toBeGreaterThan(ready.videoVersion);
      expect(ready.videoVersion).toBe(2); // PROCESSING (1) → READY (2)
      expect(byType('video.failed')[0].payload).toMatchObject({
        videoId: bad.id,
        failureCode: 'not_a_video',
        shopId: w.shop.id,
      });
    });

    it('S30 AS-56: an event whose outbox insert fails rolls the state change back: no READY, no event, the task stays unfinished', async () => {
      const v = await ingest();
      await waveUntil(['publish']);
      const release = await failOutboxInserts(
        t.app.get(Sequelize),
        'video.ready',
      );
      try {
        t.queue.take();
        await t.queue.deliver({ videoId: v.id, task: 'publish' });
      } finally {
        await release();
      }
      expect((await row(v.id)).status).toBe('PROCESSING');
      expect((await t.history(v.id)).map((h) => h.toStatus)).toEqual([
        'PROCESSING',
      ]);
      expect(await t.outbox('video.ready')).toHaveLength(0);
      expect(
        (await t.tasks(v.id)).find((x) => x.name === 'publish')!.status,
      ).toBe('QUEUED'); // back for a retry
      await t.runWaves();
      expect((await row(v.id)).status).toBe('READY');
      expect(await t.outbox('video.ready')).toHaveLength(1);
    });

    it('S30 AS-56: a delete whose event cannot be written changes nothing; one that can, writes the event with the row', async () => {
      const v = await t.video({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status: 'READY',
        outputs: OUTPUTS,
      });
      const release = await failOutboxInserts(
        t.app.get(Sequelize),
        'video.deleted',
      );
      try {
        const res = await t
          .as(w.staff)
          .delete(`/api/shops/${w.shop.id}/videos/${v.id}`);
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toMatch(/outbox|trigger|refused/i);
      } finally {
        await release();
      }
      expect(await row(v.id)).toMatchObject({ status: 'READY', version: 1 });
      expect((await t.history(v.id)).map((h) => h.toStatus)).toEqual(['READY']);
      await t
        .as(w.staff)
        .delete(`/api/shops/${w.shop.id}/videos/${v.id}`)
        .expect(204);
      expect(await t.outbox('video.deleted')).toHaveLength(1);
    });
  });

  describe('S30 US6: observability', () => {
    it('S30 AS-57: after a finished, a failed, a retried, a skipped and a timed-out task the registry shows each instrument', async () => {
      const finished = await ingest();
      await t.runWaves(); // done, transitions, upload_to_ready
      expect((await row(finished.id)).status).toBe('READY');
      await ingest(textFile());
      await t.runWaves(); // failed (permanent)
      await t.encoder!.behave([
        { match: 'scale=1280:720', action: 'fail-first', count: 1 },
        { match: STUB.sprite, action: 'fail' },
      ]);
      await ingest();
      await t.runWaves(); // a retry, and the thumbnails skipped
      await t.encoder!.reset();
      t.taskTimeout.timeoutMs = () => 1500;
      await t.encoder!.behave([{ match: 'scale=1280:720', action: 'sleep' }]);
      await ingest();
      await t.runWaves(); // timeouts
      t.taskTimeout.timeoutMs = () => 600_000;
      await t.encoder!.reset();
      const stuck = await t.video({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status: 'PROCESSING',
        createdAt: new Date(t.clock.nowMs() - 7 * 3_600_000),
      });
      void stuck;
      await t.app.get(VideoSweepService).sweep();
      const ready = await t.video({
        shopId: w.shop.id,
        uploaderId: w.staff.id,
        status: 'READY',
        outputs: OUTPUTS,
        durationSec: 6,
        width: 1280,
        height: 720,
      });
      await t.http().get(`/api/videos/${ready.id}/playback`).expect(200);
      await t.queue.deliver({ videoId: finished.id, task: 'probe' }); // a duplicate: stale

      for (const key of [
        'video_task_total{probe,done}',
        'video_task_total{transcode,done}',
        'video_task_total{probe,failed}',
        'video_task_total{transcode,retry}',
        'video_task_total{thumbnails,skipped}',
        'video_task_total{transcode,timeout}',
        'video_task_total{probe,stale}',
        'video_status_transitions_total{PROCESSING,READY}',
        'video_status_transitions_total{PROCESSING,FAILED}',
        'video_stuck_recovered_total{timeout}',
        'video_playback_total{public,ok}',
      ])
        expect(t.metrics.count(key)).toBeGreaterThan(0);
      const names = new Set(t.metrics.observed.map((o) => o.name));
      for (const name of [
        'video_task_seconds',
        'video_upload_to_ready_seconds',
        'video_queue_age_seconds',
      ])
        expect(names.has(name)).toBe(true);
    }, 120_000);

    it('S30 AS-57: every log line of a task run is structured and carries videoId, task, attempt, result and the trace of the message; none carries a secret', async () => {
      const v = await ingest();
      t.queue.take();
      await t.queue.deliver(
        { videoId: v.id, task: 'probe' },
        {
          attributes: {
            traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
            requestId: 'req-123',
          },
        },
      );
      const runs = t.logger.lines.filter((l) => l.message === 'task run');
      expect(runs).toHaveLength(1);
      expect(runs[0].fields).toMatchObject({
        videoId: v.id,
        task: 'probe',
        attempt: 1,
        result: 'done',
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        requestId: 'req-123',
      });
      // the messages it sent carry the same trace forward, and when they were sent
      const next = t.queue.pending();
      expect(next.length).toBeGreaterThan(0);
      for (const m of next) {
        expect(m.options?.attributes).toMatchObject({
          traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
          requestId: 'req-123',
        });
        expect(Number(m.options?.attributes?.sentAt)).toBeGreaterThan(0);
      }
      const all = JSON.stringify(t.logger.lines);
      expect(all).not.toMatch(/shareToken|BEGIN|X-Amz|password/i);
    });
  });

  describe('S30 US6: configuration', () => {
    const production = {
      media_bucket: 'marketplace-media',
      video_cdn_url: 'https://stream.marketplace-video.net',
      video_cookie_domain: 'marketplace-video.net',
      cloudfront_key_pair_id: 'KABCDEF',
      cloudfront_private_key:
        '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
      front_host: 'https://shop.marketplace-web.com',
      backend_host: 'https://api.marketplace-video.net',
    };
    const startup = (values: Record<string, unknown>, isProduction = true) =>
      ConfigRules.validate(
        { ...production, ...values },
        { production: isProduction },
      ).filter((line) => line.startsWith('[video]'));

    it('S30 AS-58: a complete production configuration starts; each missing or invalid setting is refused by name', () => {
      expect(startup({})).toEqual([]);
      for (const key of [
        'media_bucket',
        'video_cdn_url',
        'video_cookie_domain',
        'cloudfront_key_pair_id',
        'cloudfront_private_key',
      ])
        expect(startup({ [key]: undefined }).join()).toContain(key);
      expect(
        startup({
          video_cdn_url: 'http://stream.marketplace-video.net',
        }).join(),
      ).toContain('video_cdn_url must use https');
      expect(
        startup({ video_cdn_url: 'https://api.marketplace-video.net' }).join(),
      ).toContain('same host as backend_host');
      expect(
        startup({
          video_cdn_url: 'https://shop.marketplace-web.com',
          video_cookie_domain: 'marketplace-web.com',
        }).join(),
      ).toContain('same host as front_host');
      expect(
        startup({ video_cookie_domain: 'other-site.net' }).join(),
      ).toContain('video_cookie_domain must contain');
      expect(startup({ cloudfront_private_key: 'not a key' }).join()).toContain(
        'cloudfront_private_key must be a PEM',
      );
      for (const line of startup({ cloudfront_private_key: 'not a key' }))
        expect(line).not.toContain('not a key'); // names a key, never a value
    });

    it('S30 AS-58: outside production nothing is required (signing stays unset and unlisted playback answers 503)', () => {
      expect(
        startup(
          {
            cloudfront_key_pair_id: undefined,
            cloudfront_private_key: undefined,
            video_cdn_url: undefined,
          },
          false,
        ),
      ).toEqual([]);
    });

    it('S30 AS-58: the application refuses to start without a delivery host', async () => {
      const original = process.env.VIDEO_CDN_URL;
      delete process.env.VIDEO_CDN_URL;
      try {
        await expect(
          (async () => {
            const moduleRef = await generateTestingModule([BarrelVideoModule]);
            await moduleRef.createNestApplication().init();
          })(),
        ).rejects.toThrow(/video_cdn_url/);
      } finally {
        process.env.VIDEO_CDN_URL = original;
      }
    });
  });

  describe('S30 US6: boundaries', () => {
    it('S30 AS-59: the video tables are registered to media, point at no other owner, and the static checks find nothing in media', async () => {
      for (const table of [
        'Video',
        'VideoTask',
        'VideoStatusHistory',
        'VideoShopState',
      ])
        expect(ownerOf(table)).toBe('domain:media');
      const fks = await t.sql<{ from: string; to: string }>(
        `SELECT c.conrelid::regclass::text AS "from", c.confrelid::regclass::text AS "to" FROM pg_constraint c
          WHERE c.contype = 'f' AND (c.conrelid::regclass::text ~ '^"?Video' OR c.confrelid::regclass::text ~ '^"?Video')`,
      );
      for (const fk of fks) expect(fk.to.replace(/"/g, '')).toMatch(/^Video/); // only inside the domain
      const ownership = spawnSync(
        'pnpm',
        ['check:table-ownership', '--strict'],
        { cwd: ROOT, encoding: 'utf8' },
      );
      expect(ownership.stdout).not.toMatch(/^media\s+\(/m);
      const boundaries = spawnSync('pnpm', ['check:boundaries'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      expect(`${boundaries.stdout}${boundaries.stderr}`).not.toMatch(
        /libs\/domains\/media/,
      );
    }, 300_000);

    it('S30 AS-59: VideoModule boots from a test module that imports only the barrel', async () => {
      const moduleRef = await generateTestingModule([BarrelVideoModule]);
      const app = moduleRef.createNestApplication();
      await app.init();
      await app.close();
    }, 120_000);
  });

  // Last on purpose: a second application in the same process rebinds the model classes to its own connection, which
  // is closed with it; every describe above must have finished with the first one.
  describe('S30 US6: graceful shutdown', () => {
    let down: VideoTestApp;
    beforeAll(async () => {
      down = await createVideoApp({ worker: true });
    });

    it('S30 AS-62: closing the application kills three running encoders and puts their tasks back to QUEUED with the attempts as before, within 30 s, while the database is still open', async () => {
      await down.reset();
      const world = await down.world();
      down.encoder!.install();
      const v = await down.processingVideo({
        shopId: world.shop.id,
        uploaderId: world.staff.id,
        source: fakeVideo(),
      });
      await down.queue.wave(); // probe: the graph is stored, five tasks queued
      await down.encoder!.behave([{ match: STUB.rendition, action: 'sleep' }]);
      const rungs = down.queue
        .take()
        .filter((m) =>
          (m.body as { task: string }).task.startsWith('transcode:'),
        );
      expect(rungs).toHaveLength(3);
      const running = rungs.map((m) => down.queue.deliver(m.body)); // not awaited: the encoders hang
      for (
        let i = 0;
        i < 200 && (await down.encoder!.sleepers()).length < 3;
        i++
      )
        await new Promise((r) => setTimeout(r, 50));
      const pids = await down.encoder!.sleepers();
      expect(pids).toHaveLength(3);
      const config = down.app.get(Sequelize).config as unknown as {
        host: string;
        port: number;
        username: string;
        password: string;
        database: string;
      };
      const sent = down.queue.log.length;

      const began = Date.now();
      await down.close();
      expect(Date.now() - began).toBeLessThan(30_000);
      await Promise.allSettled(running);

      for (const pid of pids) expect(isProcessGone(pid)).toBe(true);
      const direct = new Sequelize({
        dialect: 'postgres',
        ...config,
        logging: false,
      });
      try {
        const tasks = await direct.query<{
          name: string;
          status: string;
          attempts: number;
        }>(
          `SELECT "name","status","attempts" FROM "VideoTask" WHERE "videoId" = :id AND "name" LIKE 'transcode:%' ORDER BY "name"`,
          { type: QueryTypes.SELECT, replacements: { id: v.id } },
        );
        expect(tasks.map((x) => [x.status, x.attempts])).toEqual([
          ['QUEUED', 0],
          ['QUEUED', 0],
          ['QUEUED', 0],
        ]);
      } finally {
        await direct.close();
      }
      expect(down.queue.log.length).toBe(sent + 3); // a fresh message for each, so nothing waits for a visibility timeout
    }, 90_000);
  });
});
