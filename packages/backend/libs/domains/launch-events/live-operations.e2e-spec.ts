import { v4 } from 'uuid';
import { ApiConfigService } from '@app/common/config';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { ownedBy, ownerOf } from '../../../db/ownership';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { inParallel } from '@app/test/utils/async-helpers';
import * as barrel from './index';
import { readLiveConfig } from './application/live-config';
import { ACTIVE_STREAMS } from './domain/live-keys';
import {
  createLiveApp,
  expectProblem,
  type LiveTestApp,
} from './testing/live-test-kit';

describe('Live stream: degradation, configuration, observability and domain isolation', () => {
  let t: LiveTestApp;
  let redis: RedisService;

  beforeAll(async () => {
    t = await createLiveApp({ captureLogs: true });
    redis = t.app.get(RedisService);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const wipeFastStore = async () => {
    const keys = await redis.client.keys('live:*');
    if (keys.length > 0) await redis.client.del(...keys);
  };
  const activeSet = async () =>
    (await redis.client.smembers(ACTIVE_STREAMS)).sort();
  const liveIdsInDb = async () =>
    (
      await t.rows<{ id: string }>(
        `SELECT id FROM "LiveStream" WHERE status = 'LIVE'`,
      )
    )
      .map((r) => r.id)
      .sort();

  // --- AS-49 ------------------------------------------------------------------------------------------------------

  it('S23 AS-49: after a wipe of the fast store the next comment is accepted, the pin and the mutes are intact, the recent list refills, and the statistics resume', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    const product = await t.product(s.shopId);
    const viewer = await t.viewer();
    const troll = await t.viewer();
    await t.comment(stream.id, viewer, 'before the wipe').expect(201);
    const pin = (
      await t
        .pin(s, stream.id, { productId: product.id, text: 'Buy now' })
        .expect(200)
    ).body;
    await t.mute(s, stream.id, troll.id).expect(204);

    await wipeFastStore();
    expect(await activeSet()).not.toContain(stream.id);

    await t.advance(10_000);
    await t.comment(stream.id, viewer, 'after the wipe').expect(201);
    const snapshot = (await t.snapshot(stream.id).expect(200)).body;
    expect(snapshot.pin).toEqual(pin);
    expect(snapshot.recent.map((c: { text: string }) => c.text)).toEqual([
      'after the wipe',
    ]);
    const muted = await t.comment(stream.id, troll, 'still muted?').expect(403);
    expect(expectProblem(muted.body).code).toBe('user_muted');

    // the reconcile job (every 30 seconds) puts the stream back into the set the statistics publisher walks
    await t.reconcile.run();
    expect(await activeSet()).toContain(stream.id);
    await t.advance(1_000);
    await t.ticker.tick();
    expect(
      t.published.some(
        (p) => p.topic === `stream:${stream.id}` && p.type === 'stats',
      ),
    ).toBe(true);
  });

  it('S23 AS-49: the reconcile job is scheduled every 30 seconds', async () => {
    const [schedule] = await t.rows<{
      cron: string;
      overlap: string;
      jobType: string;
      enabled: boolean;
    }>(
      `SELECT cron, overlap, "jobType", enabled FROM "JobSchedule" WHERE name = 'launch-events-live-reconcile'`,
    );
    expect(schedule).toEqual({
      cron: '*/30 * * * * *',
      overlap: 'skip',
      jobType: 'launch-events.live-reconcile',
      enabled: true,
    });
  });

  // --- AS-50 ------------------------------------------------------------------------------------------------------

  it('S23 AS-50: the reconciler adds a missing LIVE stream, drops an ENDED one and rebuilds the mute cache; two runs at once give the same result', async () => {
    const s = await t.seller();
    const running = await t.liveStream(s);
    const finished = await t.liveStream(s);
    await t.end(s, finished.id).expect(200);
    const troll = await t.viewer();
    await t.mute(s, running.id, troll.id).expect(204);

    await redis.client.srem(ACTIVE_STREAMS, running.id);
    await redis.client.sadd(ACTIVE_STREAMS, finished.id);
    await redis.client.del(
      `live:{${running.id}}:banned`,
      `live:{${running.id}}:banned-ok`,
    );

    const results = await inParallel(2, () => t.reconcile.run());
    for (const r of results) expect(r.status).toBe('fulfilled');
    const members = await activeSet();
    expect(members).toEqual(await liveIdsInDb());
    expect(members).toContain(running.id);
    expect(members).not.toContain(finished.id);
    expect(
      await redis.client.sismember(`live:{${running.id}}:banned`, troll.id),
    ).toBe(1);
    expect(await redis.client.exists(`live:{${running.id}}:banned-ok`)).toBe(1);

    await t.reconcile.run();
    expect(await activeSet()).toEqual(members);
  });

  // --- AS-51 ------------------------------------------------------------------------------------------------------

  it('S23 AS-51: with the event stream down comments are 503 live_unavailable, reactions still 202, viewers keep getting control events and the staff routes work; recovery needs no restart', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    const product = await t.product(s.shopId);
    const watcher = await t.connect(stream.id);
    await watcher.waitFor((f) => f.some((x) => x.event === 'snapshot'));
    t.stores.events.down();
    const viewer = await t.viewer();
    const failed = await t
      .comment(stream.id, viewer, 'nobody hears me')
      .expect(503);
    expect(expectProblem(failed.body).code).toBe('live_unavailable');
    await t.react(stream.id, viewer, { '❤️': 2 }).expect(202);
    await t
      .pin(s, stream.id, { productId: product.id, text: 'Still selling' })
      .expect(200);
    await watcher.waitFor((f) => f.some((x) => x.event === 'pin'));
    const second = await t.createStream(s);
    await t.start(s, second.id).expect(200);
    t.stores.events.up();
    await t.advance(10_000);
    await t.comment(stream.id, viewer, 'back again').expect(201);
    watcher.close();
  });

  it('S23 AS-51: with the fast store down comments and reactions are 503, new connections 503, the snapshot is 200 degraded, the staff routes work; recovery needs no restart', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    const viewer = await t.viewer();
    await t.comment(stream.id, viewer, 'one comment').expect(201);
    t.stores.fast.down();
    expect(
      expectProblem((await t.comment(stream.id, viewer, 'x').expect(503)).body)
        .code,
    ).toBe('live_unavailable');
    expect(
      expectProblem(
        (await t.react(stream.id, viewer, { '❤️': 1 }).expect(503)).body,
      ).code,
    ).toBe('live_unavailable');
    const refused = await t.connect(stream.id);
    expect(refused.status).toBe(503);
    const degraded = (await t.snapshot(stream.id).expect(200)).body;
    expect(degraded).toMatchObject({
      id: stream.id,
      status: 'LIVE',
      recent: [],
      degraded: true,
    });
    const other = await t.createStream(s);
    await t.start(s, other.id).expect(200);
    await t.end(s, other.id).expect(200);
    t.stores.fast.up();
    await t.advance(10_000);
    await t.comment(stream.id, viewer, 'recovered').expect(201);
    await t.react(stream.id, viewer, { '❤️': 1 }).expect(202);
    const watcher = await t.connect(stream.id);
    expect(watcher.status).toBe(200);
    watcher.close();
    const healthy = (await t.snapshot(stream.id).expect(200)).body;
    expect(healthy.degraded).toBeUndefined();
    expect(healthy.recent.length).toBeGreaterThan(0);
  });

  // --- AS-52 ------------------------------------------------------------------------------------------------------

  it('S23 AS-52: a full flow leaves every live metric, with no content in a label; no text, e-mail, token or clientId reaches a log line', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    const product = await t.product(s.shopId);
    const users = await t.viewers(12);
    const troll = users[11];
    const watcher = await t.connect(stream.id, users[0]);
    await watcher.waitFor((f) => f.some((x) => x.event === 'snapshot'));
    const secret = 'my-very-private-sentence';
    const clientId = v4();
    const first = await t
      .comment(stream.id, users[0], { text: secret, clientId })
      .expect(201);
    await t.comment(stream.id, users[1], 'scam').expect(422);
    t.stores.limiter.down();
    for (let i = 2; i < 10; i++)
      await t.comment(stream.id, users[i], `flood ${i}`).expect(201);
    t.stores.limiter.up();
    await t.fed(stream.id, 9);
    t.window();
    await watcher.waitFor((f) => f.some((x) => x.event === 'comments'));
    await t.react(stream.id, users[0], { '❤️': 3 }).expect(202);
    await t
      .pin(s, stream.id, { productId: product.id, text: 'Buy' })
      .expect(200);
    await t.removeComment(s, stream.id, first.body.id).expect(204);
    await t.mute(s, stream.id, troll.id).expect(204);
    await t.comment(stream.id, troll, 'let me in').expect(403);
    await t.advance(1_000);
    await t.ticker.tick();
    await t.history.project(
      t.sent.filter((e) => e.type === 'live.comment_posted'),
    );
    t.historyIo.throttleNext(1_000_000);
    await expect(t.history.project(t.sent.slice(0, 1))).rejects.toThrow();
    t.historyIo.throttleNext(0);
    await t.end(s, stream.id).expect(200);
    await watcher.waitForEnd(2_000);

    const value = (name: string, labels = {}) =>
      MetricsRegistry.value(name, labels);
    expect(
      value('live_comments_total', { result: 'accepted', reason: 'none' }),
    ).toBeGreaterThan(0);
    expect(
      value('live_comments_total', { result: 'blocked', reason: 'policy' }),
    ).toBeGreaterThan(0);
    expect(
      value('live_comments_total', { result: 'muted', reason: 'none' }),
    ).toBeGreaterThan(0);
    expect(value('live_batch_items')).toBeGreaterThan(0);
    expect(value('live_window_comments')).toBeDefined();
    expect(
      MetricsRegistry.histogramValue('live_delivery_lag_seconds')?.count,
    ).toBeGreaterThan(0);
    expect(value('live_viewers')).toBeDefined();
    expect(
      value('live_viewers_dropped_total', { reason: 'ended' }),
    ).toBeGreaterThan(0);
    expect(value('live_reactions_total')).toBeGreaterThanOrEqual(3);
    expect(value('live_stats_published_total')).toBeGreaterThan(0);
    expect(
      value('live_removals_total', { source: 'moderator' }),
    ).toBeGreaterThan(0);
    expect(
      MetricsRegistry.histogramValue('live_history_lag_seconds')?.count,
    ).toBeGreaterThan(0);
    expect(
      value('live_consumer_failures_total', {
        consumer: 'live-comments-history',
      }),
    ).toBeGreaterThan(0);

    const allowed = new Set([
      'result',
      'reason',
      'reaction',
      'source',
      'consumer',
      'policy',
    ]);
    for (const name of [
      'live_comments_total',
      'live_viewers_dropped_total',
      'live_removals_total',
      'live_consumer_failures_total',
      'live_limiter_unavailable_total',
    ])
      for (const labels of MetricsRegistry.labelSets(name))
        for (const [key, v] of Object.entries(labels)) {
          expect(allowed.has(key)).toBe(true);
          expect(String(v)).not.toContain(secret);
          expect(String(v)).not.toContain(users[0].email);
        }

    const lines = t.logLines();
    expect(lines).not.toContain(secret);
    expect(lines).not.toContain(users[0].email);
    expect(lines).not.toContain(clientId);
    expect(lines).not.toContain(users[0].auth.Authorization.slice(7));
    expect(lines).not.toContain('flood 4');
  });

  it('S23 AS-52: a log line of the live path carries the stream and the request', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    const viewer = await t.viewer();
    t.stores.events.down();
    await t.comment(stream.id, viewer, 'will fail').expect(503);
    const mine = t
      .logLines()
      .split('\n')
      .filter(
        (line) =>
          line.includes(stream.id) && line.includes('comment_not_durable'),
      );
    expect(mine.length).toBeGreaterThan(0);
    for (const line of mine) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.streamId).toBe(stream.id);
      expect(typeof parsed.requestId).toBe('string');
    }
  });

  // --- AS-54 ------------------------------------------------------------------------------------------------------

  it('S23 AS-54: the barrel exports only Nest modules (and contract types); the live tables are in the ownership registry', () => {
    expect(Object.keys(barrel).sort()).toEqual([
      'LaunchEventTopicsModule',
      'LaunchEventsModule',
      'LaunchEventsWorkerModule',
      'LiveGatewayModule',
      'LiveModule',
      'LiveProjectorModule',
      'LiveTopicsModule',
      'LiveWorkerModule',
    ]);
    expect(ownerOf('LiveStream')).toBe('domain:launch-events');
    expect(ownerOf('LiveMute')).toBe('domain:launch-events');
    expect(ownedBy('domain:launch-events' as never)).toEqual(
      expect.arrayContaining(['LiveStream', 'LiveMute']),
    );
  });
});

describe('Live stream: configuration', () => {
  it('S23 AS-53: the defaults are a 250 ms window, 5 sampled comments, 50,000 viewers and a 0.7 threshold', () => {
    expect(
      readLiveConfig({ get: () => undefined } as unknown as ApiConfigService),
    ).toEqual({
      windowMs: 250,
      sampleSize: 5,
      viewerCap: 50_000,
      moderationThreshold: 0.7,
    });
  });

  it.each([
    ['LIVE_WINDOW_MS', '0', 'live_window_ms'],
    ['LIVE_WINDOW_MS', '-5', 'live_window_ms'],
    ['LIVE_SAMPLE_SIZE', '0', 'live_sample_size'],
    ['LIVE_SAMPLE_SIZE', '51', 'live_sample_size'],
    ['LIVE_VIEWER_CAP', '0', 'live_viewer_cap'],
    ['LIVE_VIEWER_CAP', '-1', 'live_viewer_cap'],
    ['LIVE_MODERATION_THRESHOLD', '0', 'live_moderation_threshold'],
    ['LIVE_MODERATION_THRESHOLD', '1.5', 'live_moderation_threshold'],
  ])(
    'S23 AS-53: %s=%s refuses the start and names %s',
    async (variable, value, setting) => {
      const previous = process.env[variable];
      process.env[variable] = value;
      try {
        await expect(createLiveApp()).rejects.toThrow(new RegExp(setting));
      } finally {
        if (previous === undefined) delete process.env[variable];
        else process.env[variable] = previous;
      }
    },
    60_000,
  );

  it('S23 AS-53: valid values are taken as they are', async () => {
    const env = {
      LIVE_WINDOW_MS: '500',
      LIVE_SAMPLE_SIZE: '10',
      LIVE_VIEWER_CAP: '7',
      LIVE_MODERATION_THRESHOLD: '0.9',
    };
    Object.assign(process.env, env);
    try {
      const t = await createLiveApp();
      try {
        expect(readLiveConfig(t.app.get(ApiConfigService))).toEqual({
          windowMs: 500,
          sampleSize: 10,
          viewerCap: 7,
          moderationThreshold: 0.9,
        });
      } finally {
        await t.close();
      }
    } finally {
      for (const key of Object.keys(env)) delete process.env[key];
    }
  }, 60_000);
});
