import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { videoEventSchemas } from '@marketplace-sandbox/contracts';
import { renditionPrefix } from './domain/delivery-paths';
import { VideoStore } from './domain/video-ports';
import {
  ChildExitError,
  isProcessGone,
  runBounded,
} from './infra/child-process';
import { STUB } from './testing/stub-encoder';
import {
  audioOnlyFile,
  fakeVideo,
  realClip,
  textFile,
  truncatedMp4,
} from './testing/test-videos';
import { describeWithFfmpeg } from './testing/require-ffmpeg';
import {
  createVideoApp,
  type VideoTestApp,
  type VideoWorld,
} from './testing/video-app';

const RUNGS = ['transcode:240', 'transcode:480', 'transcode:720'];
const sorted = (names: string[]) => [...names].sort();

describe('Video transcoding pipeline', () => {
  let t: VideoTestApp;
  let w: VideoWorld;

  beforeAll(async () => {
    t = await createVideoApp({ worker: true, storageProxy: true });
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
    t.storageProxy!.mode = 'pass';
    jest.restoreAllMocks();
  });

  const ingest = (
    source: Buffer,
    over: { visibility?: 'public' | 'unlisted' } = {},
  ) =>
    t.processingVideo({
      shopId: w.shop.id,
      uploaderId: w.staff.id,
      source,
      ...over,
    });
  const taskState = async (id: string) =>
    Object.fromEntries(
      (await t.tasks(id)).map((x) => [
        x.name,
        { status: x.status, attempts: x.attempts },
      ]),
    ) as Record<string, { status: string; attempts: number }>;
  const pendingNames = () =>
    t.queue
      .pending()
      .map((m) => (m.body as { task: string }).task)
      .sort();
  /** Delivers waves until exactly `names` is what is left to deliver. */
  const waveUntil = async (names: string[]) => {
    for (let i = 0; i < 10; i++) {
      if (JSON.stringify(pendingNames()) === JSON.stringify(sorted(names)))
        return;
      await t.queue.wave();
    }
    throw new Error(
      `never reached ${names.join(',')}: ${pendingNames().join(',')}`,
    );
  };
  const text = async (key: string) => {
    const chunks: Buffer[] = [];
    for await (const c of (await t.storage.getStream(
      key,
    )) as AsyncIterable<Buffer>)
      chunks.push(Buffer.from(c));
    return Buffer.concat(chunks).toString('utf8');
  };
  const count = (name: string) => t.metrics.count(name);

  describe('S30 US2: the graph runs once, wave by wave', () => {
    it('S30 AS-15: probe, then poster + thumbnails + three renditions, then package, then publish → READY with its files and one video.ready', async () => {
      const v = await ingest(
        fakeVideo({ width: 1280, height: 720, duration: 6 }),
      );
      const waves = await t.runWaves();
      expect(waves.map(sorted)).toEqual([
        ['probe'],
        sorted(['poster', 'thumbnails', ...RUNGS]),
        ['package'],
        ['publish'],
      ]);
      const row = (await t.row(v.id))!;
      expect(row).toMatchObject({ status: 'READY', width: 1280, height: 720 });
      expect(Number(row.durationSec)).toBe(6);
      expect(
        row.outputs.renditions.map((r: { name: string }) => r.name),
      ).toEqual(['240p', '480p', '720p']);
      const master = await text(`p/${v.id}/master.m3u8`);
      expect(master.match(/#EXT-X-STREAM-INF/g)).toHaveLength(3);
      const playlists = master
        .split('\n')
        .filter((l) => l.endsWith('index.m3u8'));
      expect(playlists).toHaveLength(3);
      for (const p of playlists) {
        const body = await text(`p/${v.id}/${p}`);
        expect(body).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
        expect(body).toContain('#EXT-X-ENDLIST');
      }
      expect(await t.objectExists(`p/${v.id}/poster/a1/poster.jpg`)).toBe(true);
      expect(await t.objectExists(`p/${v.id}/sprite/a1/sprite.jpg`)).toBe(true);
      expect(await t.objectExists(`p/${v.id}/sprite/a1/sprite.vtt`)).toBe(true);
      const ready = await t.outbox('video.ready');
      expect(ready).toHaveLength(1);
      expect(
        videoEventSchemas['video.ready'].parse(ready[0].payload),
      ).toMatchObject({
        videoId: v.id,
        shopId: w.shop.id,
        hasSprite: true,
      });
      expect(
        (await t.history(v.id)).map((h) => `${h.fromStatus}>${h.toStatus}`),
      ).toEqual(['null>PROCESSING', 'PROCESSING>READY']);
      expect(
        Object.values(await taskState(v.id)).every((x) => x.status === 'DONE'),
      ).toBe(true);
      // nothing but the delivery prefix was written, and the source stays private
      expect(await t.objectExists(v.sourceKey)).toBe(true);
      expect(
        t.queue.log.every(
          (m) =>
            !('groupId' in (m.options ?? {})) &&
            !('dedupeId' in (m.options ?? {})),
        ),
      ).toBe(true);
    });

    it('S30 AS-15: an unlisted video is published under the unlisted prefix only', async () => {
      const v = await ingest(fakeVideo(), { visibility: 'unlisted' });
      await t.runWaves();
      expect(await t.objectExists(`u/${v.id}/master.m3u8`)).toBe(true);
      expect(await t.objectExists(`p/${v.id}/master.m3u8`)).toBe(false);
      expect((await t.row(v.id))!.status).toBe('READY');
    });

    it.each([
      ['a text file', textFile, 'not_a_video'],
      ['an audio-only file', audioOnlyFile, 'no_video_stream'],
      ['a truncated MP4', truncatedMp4, 'not_a_video'],
    ])(
      'S30 AS-21: %s fails the video with %s after one attempt, no output, one video.failed',
      async (_name, make, code) => {
        const v = await ingest(make());
        await t.runWaves();
        expect((await t.row(v.id))!).toMatchObject({
          status: 'FAILED',
          failureCode: code,
        });
        expect(await taskState(v.id)).toEqual({
          probe: { status: 'FAILED', attempts: 1 },
        });
        expect(await t.storage.list(`p/${v.id}/`)).toHaveLength(0);
        expect(await t.storage.list(`u/${v.id}/`)).toHaveLength(0);
        expect(await t.objectExists(v.sourceKey)).toBe(true); // kept for the retention window
        const failed = await t.outbox('video.failed');
        expect(failed).toHaveLength(1);
        expect(
          videoEventSchemas['video.failed'].parse(failed[0].payload)
            .failureCode,
        ).toBe(code);
        expect(t.queue.pending()).toHaveLength(0); // a permanent failure is never retried
      },
    );

    it('S30 AS-22: four siblings finishing at once queue package exactly once; a duplicate message for a finished task is a stale no-op', async () => {
      for (let round = 0; round < 3; round++) {
        const v = await ingest(fakeVideo());
        await waveUntil(sorted(['poster', 'thumbnails', ...RUNGS]));
        const wave = t.queue.take();
        await Promise.all(wave.map((m) => t.queue.deliver(m.body)));
        expect(pendingNames()).toEqual(['package']);
        const afterPackage = await t.tasks(v.id);
        expect(afterPackage.find((x) => x.name === 'package')!.status).toBe(
          'QUEUED',
        );

        const rows = JSON.stringify(await t.tasks(v.id));
        const stale = count('video_task_total{poster,stale}');
        await t.queue.deliver({ videoId: v.id, task: 'poster' });
        expect(count('video_task_total{poster,stale}')).toBe(stale + 1);
        expect(JSON.stringify(await t.tasks(v.id))).toBe(rows);
        expect(pendingNames()).toEqual(['package']);
        await t.runWaves();
        expect((await t.row(v.id))!.status).toBe('READY');
        t.queue.log.length = 0;
      }
    });

    it("S30 AS-23: the same message on two workers at once runs once; the other is busy and costs no attempt; an expired lease is taken over and the first worker's late completion is refused", async () => {
      await t.encoder!.behave([
        { match: STUB.probe, action: 'delay-first', count: 1, ms: 800 },
      ]);
      const v = await ingest(fakeVideo());
      const body = { videoId: v.id, task: 'probe' };
      t.queue.take();
      await Promise.all([t.queue.deliver(body), t.queue.deliver(body)]);
      expect(count('video_task_total{probe,done}')).toBe(1);
      expect(count('video_task_total{probe,busy}')).toBe(1);
      expect((await taskState(v.id)).probe).toEqual({
        status: 'DONE',
        attempts: 1,
      });
    });

    it('S30 AS-23: a worker that stopped heartbeating for the lease is replaced; the attempt is counted and the old attempt cannot finish', async () => {
      const v = await ingest(fakeVideo());
      t.queue.take();
      const store = t.app.get(VideoStore);
      const first = await store.tasks.claim({
        videoId: v.id,
        name: 'probe',
        now: t.clock.now(),
        leaseUntil: new Date(t.clock.nowMs() + 300_000),
        maxAttempts: 3,
      });
      expect(first.outcome).toBe('claimed');
      // inside the lease another delivery is busy
      await t.queue.deliver({ videoId: v.id, task: 'probe' });
      expect(count('video_task_total{probe,busy}')).toBe(1);
      expect((await taskState(v.id)).probe.attempts).toBe(1);
      // past the lease it takes over
      t.clock.advance(300_001);
      await t.queue.deliver({ videoId: v.id, task: 'probe' });
      expect((await taskState(v.id)).probe).toEqual({
        status: 'DONE',
        attempts: 2,
      });
      const late = await store.tasks.complete({
        videoId: v.id,
        name: 'probe',
        attempt: 1,
        output: {},
        now: t.clock.now(),
      });
      expect(late).toBe(false);
    });

    it('S30 AS-22: a message whose body breaks the schema is dead-lettered at once and runs nothing', async () => {
      const v = await ingest(fakeVideo());
      t.queue.take();
      for (const body of [
        { videoId: 'not-a-uuid', task: 'probe' },
        { videoId: v.id, task: 'rm -rf' },
        { videoId: v.id, task: 'probe', extra: 1 },
      ])
        t.queue.sent.push({ queue: 'video-transcode', body });
      await t.queue.drain('video-transcode');
      expect(t.queue.deadLettered.map((d) => d.reason)).toEqual([
        'SCHEMA_INVALID',
        'SCHEMA_INVALID',
        'SCHEMA_INVALID',
      ]);
      expect((await taskState(v.id)).probe).toEqual({
        status: 'QUEUED',
        attempts: 0,
      });
    });

    it('S30 AS-29: progress starts at one task, never goes down and ends equal at READY', async () => {
      const v = await ingest(fakeVideo());
      const store = t.app.get(VideoStore);
      const seen = [await store.tasks.progress(v.id)];
      expect(seen[0]).toMatchObject({ tasksDone: 0, tasksTotal: 1 });
      while (t.queue.pending().length) {
        await t.queue.wave();
        seen.push(await store.tasks.progress(v.id));
      }
      const done = seen.map((p) => p.tasksDone);
      expect(done).toEqual([...done].sort((a, b) => a - b));
      expect(seen[1].tasksTotal).toBe(8); // probe, poster, thumbnails, three renditions, package, publish
      const last = seen[seen.length - 1];
      expect(last.tasksDone).toBe(last.tasksTotal);
    });
  });

  describe('S30 US2: retries, timeouts, fencing', () => {
    it('S30 AS-24: a rendition that fails twice is re-queued with delays of 30 s then 120 s and then succeeds', async () => {
      await t.encoder!.behave([
        { match: 'scale=1280:720', action: 'fail-first', count: 2 },
      ]);
      const v = await ingest(fakeVideo());
      await t.runWaves();
      expect((await t.row(v.id))!.status).toBe('READY');
      expect((await taskState(v.id))['transcode:720']).toEqual({
        status: 'DONE',
        attempts: 3,
      });
      expect((await taskState(v.id))['transcode:480'].attempts).toBe(1);
      const retries = t.queue.log.filter(
        (m) =>
          (m.body as { task: string }).task === 'transcode:720' &&
          m.options?.delaySeconds,
      );
      expect(retries.map((m) => m.options!.delaySeconds)).toEqual([30, 120]);
      expect(count('video_task_total{transcode,retry}')).toBe(2);
      // L-001: the standard queue never gets a FIFO option
      for (const m of t.queue.log) {
        expect(m.options ?? {}).not.toHaveProperty('groupId');
        expect(m.options ?? {}).not.toHaveProperty('dedupeId');
      }
    });

    it('S30 AS-24: three failures fail the task and the video (transcode_failed), cancel the rest, write one video.failed; a fourth message is a no-op', async () => {
      await t.encoder!.behave([{ match: 'scale=1280:720', action: 'fail' }]);
      const v = await ingest(fakeVideo());
      await t.runWaves();
      expect((await t.row(v.id))!).toMatchObject({
        status: 'FAILED',
        failureCode: 'transcode_failed',
      });
      const states = await taskState(v.id);
      expect(states['transcode:720']).toEqual({
        status: 'FAILED',
        attempts: 3,
      });
      expect(states.package.status).toBe('CANCELLED');
      expect(states.publish.status).toBe('CANCELLED');
      expect(await t.outbox('video.failed')).toHaveLength(1);
      const before = JSON.stringify(await t.tasks(v.id));
      await t.queue.deliver({ videoId: v.id, task: 'transcode:720' });
      expect(JSON.stringify(await t.tasks(v.id))).toBe(before);
      expect(t.queue.pending()).toHaveLength(0);
    });

    it('S30 AS-24: storage unreachable on every attempt fails the video as storage_unavailable with one video.failed', async () => {
      const v = await ingest(fakeVideo());
      await waveUntil(sorted(['poster', 'thumbnails', ...RUNGS]));
      t.storageProxy!.mode = 'refuse';
      await t.runWaves();
      expect((await t.row(v.id))!).toMatchObject({
        status: 'FAILED',
        failureCode: 'storage_unavailable',
      });
      expect(await t.outbox('video.failed')).toHaveLength(1);
      expect(t.queue.pending()).toHaveLength(0);
    }, 120_000);

    it('S30 AS-25: a hung encoder is killed at the time limit, is gone from the process table, counts as task_timeout; three of them fail the video task_timeout', async () => {
      t.taskTimeout.timeoutMs = () => 1500;
      await t.encoder!.behave([{ match: 'scale=1280:720', action: 'sleep' }]);
      const v = await ingest(fakeVideo());
      await t.runWaves();
      expect((await t.row(v.id))!).toMatchObject({
        status: 'FAILED',
        failureCode: 'task_timeout',
      });
      const pids = await t.encoder!.sleepers();
      expect(pids).toHaveLength(3);
      for (const pid of pids) expect(isProcessGone(pid)).toBe(true);
      expect(count('video_task_total{transcode,timeout}')).toBe(3);
    }, 60_000);

    it('S30 AS-25: ten megabytes on both output streams are kept to 4 KB and 1 MB, and an argument with shell characters is inert', async () => {
      await t.encoder!.behave([{ match: 'x', action: 'flood' }]);
      const err = await runBounded({
        command: 'ffmpeg',
        args: ['x'],
        timeoutMs: 20_000,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(ChildExitError);
      expect((err as ChildExitError).stderrTail.length).toBeLessThanOrEqual(
        4096,
      );
      const big = await runBounded({
        command: process.execPath,
        args: ['-e', "process.stdout.write(Buffer.alloc(10*1024*1024, 'y'))"],
        timeoutMs: 20_000,
      });
      expect(big.stdout.length).toBeLessThanOrEqual(1024 * 1024);

      const dir = await mkdtemp(join(tmpdir(), 'inert-'));
      try {
        const evil = `a; touch ${join(dir, 'pwned')} $(touch ${join(dir, 'pwned2')}) \`id\``;
        const echoed = await runBounded({
          command: 'echo',
          args: [evil],
          timeoutMs: 5000,
        });
        expect(echoed.stdout.trim()).toBe(evil);
        expect(existsSync(join(dir, 'pwned'))).toBe(false);
        expect(existsSync(join(dir, 'pwned2'))).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('S30 AS-26: an attempt that lost its lease writes to its own location, cannot mark DONE, has its objects removed, and the master names the other attempt', async () => {
      const v = await ingest(fakeVideo());
      await waveUntil(sorted(['poster', 'thumbnails', ...RUNGS]));
      const rest = t.queue.take();
      const slow = rest.find(
        (m) => (m.body as { task: string }).task === 'transcode:720',
      )!;
      const others = rest.filter((m) => m !== slow);
      await t.encoder!.behave([
        { match: 'scale=1280:720', action: 'delay-first', count: 1, ms: 1500 },
      ]);
      // worker A starts attempt 1 and is slow; its lease runs out (frozen clock) while worker B takes over as attempt 2
      const first = t.queue.deliver(slow.body);
      await new Promise((r) => setTimeout(r, 500));
      t.clock.advance(300_001);
      await Promise.all([
        t.queue.deliver(slow.body),
        ...others.map((m) => t.queue.deliver(m.body)),
      ]);
      await first;
      const state = (await taskState(v.id))['transcode:720'];
      expect(state).toEqual({ status: 'DONE', attempts: 2 });
      const a1 = renditionPrefix('public', v.id, 720, 1);
      const a2 = renditionPrefix('public', v.id, 720, 2);
      expect(await t.storage.list(a1)).toHaveLength(0); // the loser's objects are removed
      expect((await t.storage.list(a2)).length).toBeGreaterThan(0);
      await t.runWaves();
      const master = await text(`p/${v.id}/master.m3u8`);
      expect(master).toContain('r/720/a2/index.m3u8');
      expect(master).not.toContain('r/720/a1/');
    }, 60_000);

    it('S30 AS-27: a delete racing the publish never leaves READY after DELETED, and no video.ready exists when the delete won', async () => {
      const store = t.app.get(VideoStore);
      for (let i = 0; i < 6; i++) {
        const v = await ingest(fakeVideo());
        await waveUntil(['publish']);
        const body = t.queue.take()[0].body;
        await Promise.all([
          t.queue.deliver(body),
          store.tx(({ video }) =>
            video.softDelete({
              id: v.id,
              shopId: w.shop.id,
              actor: { type: 'user', id: w.owner.id },
              now: t.clock.now(),
            }),
          ),
        ]);
        const history = (await t.history(v.id)).map((h) => h.toStatus);
        expect(history[history.length - 1]).toBe('DELETED');
        expect((await t.row(v.id))!.status).toBe('DELETED');
        const readyAt = history.indexOf('READY');
        const ready = (await t.outbox('video.ready')).filter(
          (e) => e.aggregateId === v.id,
        );
        expect(ready).toHaveLength(readyAt >= 0 ? 1 : 0);
        if (readyAt >= 0)
          expect(history.indexOf('DELETED')).toBeGreaterThan(readyAt);
        expect(
          (await t.outbox('video.deleted')).filter(
            (e) => e.aggregateId === v.id,
          ),
        ).toHaveLength(1);
      }
    }, 60_000);

    it('S30 AS-28: a thumbnails task that fails three times is SKIPPED, the video is READY without a sprite; a working one is capped and described', async () => {
      await t.encoder!.behave([{ match: STUB.sprite, action: 'fail' }]);
      const skipped = await ingest(fakeVideo());
      await t.runWaves();
      expect((await taskState(skipped.id)).thumbnails).toEqual({
        status: 'SKIPPED',
        attempts: 3,
      });
      const row = (await t.row(skipped.id))!;
      expect(row.status).toBe('READY');
      expect(row.outputs.sprite).toBeNull();
      expect(
        (await t.outbox('video.ready')).find(
          (e) => e.aggregateId === skipped.id,
        )!.payload.hasSprite,
      ).toBe(false);

      await t.encoder!.reset();
      const ok = await ingest(fakeVideo({ duration: 250 }));
      await t.runWaves();
      const calls = await t.encoder!.calls(STUB.sprite);
      expect(calls[0]).toContain('fps=1/10');
      expect(calls[0]).toContain('scale=160:90');
      expect(calls[0]).toContain('tile=10x3'); // 25 tiles, ten per row
      const vtt = await text(`p/${ok.id}/sprite/a1/sprite.vtt`);
      expect(vtt.startsWith('WEBVTT')).toBe(true);
      expect(vtt.match(/-->/g)).toHaveLength(25);
      expect(vtt).toContain('sprite.jpg#xywh=0,0,160,90');
      expect((await t.row(ok.id))!.outputs.sprite).toMatch(
        /^sprite\/a1\/sprite\.jpg$/,
      );
    });

    it('S30 AS-30: a rendition whose last segment is missing in storage fails package retryably, writes no master and does not publish', async () => {
      const v = await ingest(fakeVideo());
      await waveUntil(['package']);
      const tasks = await t.tasks(v.id);
      const r480 = tasks.find((x) => x.name === 'transcode:480')!;
      await t.storage.delete(`p/${v.id}/r/480/a1/${r480.output.lastSegment}`);
      await t.queue.wave();
      expect((await taskState(v.id)).package).toEqual({
        status: 'QUEUED',
        attempts: 1,
      });
      expect(await t.objectExists(`p/${v.id}/master.m3u8`)).toBe(false);
      expect((await t.row(v.id))!.status).toBe('PROCESSING');
      expect(
        t.queue.log.filter((m) => m.options?.delaySeconds === 30),
      ).toHaveLength(1);
      await t.runWaves();
      expect((await t.row(v.id))!).toMatchObject({
        status: 'FAILED',
        failureCode: 'transcode_failed',
      });
      expect(await t.objectExists(`p/${v.id}/master.m3u8`)).toBe(false);
    });
  });

  describe('S30 US2: the real encoder', () => {
    describeWithFfmpeg('real ffmpeg and ffprobe', () => {
      beforeEach(() => t.encoder!.uninstall());

      it('S30 AS-15: a real 6-second 720p clip with audio becomes READY with a three-rung master', async () => {
        const v = await ingest(await realClip({ seconds: 6, fps: 30 }));
        await t.runWaves();
        expect((await t.row(v.id))!.status).toBe('READY');
        const master = await text(`p/${v.id}/master.m3u8`);
        expect(master.match(/#EXT-X-STREAM-INF/g)).toHaveLength(3);
      }, 180_000);

      it.each([24, 25, 30, 50, 60])(
        'S30 AS-18: a %d fps source gives every rendition the same segments, each starting on a keyframe',
        async (fps) => {
          const v = await ingest(await realClip({ seconds: 10, fps }));
          await t.runWaves();
          const durations: number[][] = [];
          for (const rung of [240, 480, 720]) {
            const prefix = `p/${v.id}/r/${rung}/a1/`;
            const playlist = await text(`${prefix}index.m3u8`);
            expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
            expect(playlist).toContain('#EXT-X-ENDLIST');
            expect(playlist).toContain('#EXT-X-TARGETDURATION:4');
            const extinf = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map(
              (m) => Number(m[1]),
            );
            expect(Math.max(...extinf)).toBeLessThanOrEqual(4.5);
            durations.push(extinf);
            const first = playlist.split('\n').find((l) => l.endsWith('.ts'))!;
            const dir = await mkdtemp(join(tmpdir(), 'seg-'));
            try {
              await writeFile(
                join(dir, 'seg.ts'),
                await t.objectBytes(`${prefix}${first}`),
              );
              const probe = spawnSync(
                'ffprobe',
                [
                  '-v',
                  'error',
                  '-select_streams',
                  'v:0',
                  '-show_entries',
                  'packet=flags',
                  '-of',
                  'csv=p=0',
                  join(dir, 'seg.ts'),
                ],
                { encoding: 'utf8' },
              );
              expect(probe.stdout.split('\n')[0]).toContain('K');
            } finally {
              await rm(dir, { recursive: true, force: true });
            }
          }
          expect(new Set(durations.map((d) => d.length)).size).toBe(1);
          for (let i = 0; i < durations[0].length; i++)
            for (const d of durations)
              expect(Math.abs(d[i] - durations[0][i])).toBeLessThan(
                1 / fps + 1e-3,
              );
        },
        240_000,
      );

      it('S30 AS-19: the master states the measured peak and average, the real size, frame rate and codecs; a silent source has no audio codec', async () => {
        const v = await ingest(
          await realClip({ seconds: 8, fps: 30, audio: false }),
        );
        await t.runWaves();
        const master = await text(`p/${v.id}/master.m3u8`);
        for (const line of master
          .split('\n')
          .filter((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
          expect(line).toMatch(
            /BANDWIDTH=\d+,AVERAGE-BANDWIDTH=\d+,RESOLUTION=\d+x\d+,FRAME-RATE=30\.000/,
          );
          expect(line).not.toContain('mp4a');
          expect(line).toMatch(/CODECS="avc1\.[0-9a-f]{6}"/);
        }
      }, 180_000);
    });
  });
});
