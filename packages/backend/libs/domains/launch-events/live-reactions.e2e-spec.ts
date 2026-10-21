import { v4 } from 'uuid';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { waitFor, inParallel } from '@app/test/utils/async-helpers';
import { ACTIVE_STREAMS } from './domain/live-keys';
import {
  createLiveApp,
  expectProblem,
  type LiveTestApp,
} from './testing/live-test-kit';

describe('Live stream: reactions, statistics and viewer counts', () => {
  let t: LiveTestApp;

  beforeAll(async () => {
    t = await createLiveApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const stats = (streamId: string) =>
    t.published
      .filter((p) => p.topic === `stream:${streamId}` && p.type === 'stats')
      .map(
        (p) =>
          p.data as {
            second: number;
            reactions: Record<string, number>;
            viewers: number;
          },
      );
  const aggregated = (streamId?: string) =>
    t.sent.filter(
      (e) =>
        e.type === 'live.reactions_aggregated' &&
        (!streamId || e.aggregateId === streamId),
    );
  const secondNow = () => Math.floor(t.clock.nowMs() / 1000);
  const liveStream = async () => {
    const s = await t.seller();
    return { s, stream: await t.liveStream(s) };
  };

  // --- AS-14 ------------------------------------------------------------------------------------------------------

  it('S23 AS-14: the viewer count is the sum over gateway instances; an instance that stopped reporting counts for nothing after 15 seconds', async () => {
    const { stream } = await liveStream();
    await t.viewerCounts.report(stream.id, 'gateway-a', 100, t.clock.nowMs());
    await t.viewerCounts.report(stream.id, 'gateway-b', 50, t.clock.nowMs());
    await t.advance(1_000);
    await t.ticker.tick();
    expect(stats(stream.id).at(-1)?.viewers).toBe(150);

    await t.advance(16_000);
    await t.viewerCounts.report(stream.id, 'gateway-b', 50, t.clock.nowMs());
    await t.ticker.tick();
    expect(stats(stream.id).at(-1)?.viewers).toBe(50);
  });

  // --- AS-26 ------------------------------------------------------------------------------------------------------

  it('S23 AS-26: an accepted reaction batch is 202 with no body; it only adds to the current second’s counters', async () => {
    const { stream } = await liveStream();
    const viewer = await t.viewer();
    await t.react(stream.id, await t.viewer(), { '👏': 1 }).expect(202); // fills the stream state cache
    await t.counters.add(stream.id, secondNow(), {});
    t.queries.count = 0;
    const res = await t
      .react(stream.id, viewer, { '❤️': 7, '🔥': 2 })
      .expect(202);
    expect(res.text).toBe('');
    expect(await t.counters.totals(stream.id, secondNow())).toEqual({
      '👏': 1,
      '❤️': 7,
      '🔥': 2,
    });
    expect(t.queries.sql).toEqual([]);
    expect(t.sent).toHaveLength(0);
    expect(t.stores.history.count()).toBe(0);
    expect(
      t.published.filter(
        (p) => p.topic === `stream:${stream.id}` && p.type !== 'status',
      ),
    ).toEqual([]);
  });

  // --- AS-27 ------------------------------------------------------------------------------------------------------

  it('S23 AS-27: 100 concurrent requests of seven hearts become 700 in the next stats; only totals reach viewers; zero counts are omitted', async () => {
    const { stream } = await liveStream();
    t.stores.limiter.down(); // the per-user budget is AS-30's subject
    const viewer = await t.viewer();
    const second = secondNow();
    const results = await inParallel(100, () =>
      t.react(stream.id, viewer, { '❤️': 7 }),
    );
    for (const r of results)
      expect(
        (r as PromiseFulfilledResult<{ status: number }>).value.status,
      ).toBe(202);
    await t.advance(1_000);
    await t.ticker.tick();
    const published = stats(stream.id);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ second, reactions: { '❤️': 700 } });
    expect(Object.keys(published[0].reactions)).toEqual(['❤️']);
    const types = new Set(
      t.published
        .filter((p) => p.topic === `stream:${stream.id}`)
        .map((p) => p.type),
    );
    expect([...types].sort()).toEqual(['stats', 'status']);
  });

  it('S23 AS-27: a second without reactions still publishes stats with the viewer count', async () => {
    const { stream } = await liveStream();
    await t.viewerCounts.report(stream.id, 'gateway-a', 12, t.clock.nowMs());
    await t.advance(1_000);
    await t.ticker.tick();
    expect(stats(stream.id)).toEqual([
      { second: secondNow() - 1, reactions: {}, viewers: 12 },
    ]);
  });

  // --- AS-28 ------------------------------------------------------------------------------------------------------

  it.each([
    ['an emoji outside the six', { '👍': 1 }],
    ['a count of 0', { '❤️': 0 }],
    ['a negative count', { '❤️': -1 }],
    ['a count over 20', { '❤️': 21 }],
    ['a fractional count', { '❤️': 1.5 }],
    ['a non-numeric count', { '❤️': '7' }],
    ['an empty object', {}],
    [
      'more than six keys',
      { '❤️': 1, '🔥': 1, '😂': 1, '😮': 1, '👏': 1, '🛒': 1, '👍': 1 },
    ],
    [
      'a valid emoji next to an invalid one (all or nothing)',
      { '❤️': 3, '🔥': 99 },
    ],
  ])(
    'S23 AS-28: %s is 422 and nothing is counted',
    async (_name, reactions) => {
      const { stream } = await liveStream();
      const res = await t
        .react(stream.id, await t.viewer(), reactions)
        .expect(422);
      expect(expectProblem(res.body).errors?.length).toBeGreaterThan(0);
      expect(await t.counters.totals(stream.id, secondNow())).toEqual({});
    },
  );

  it('S23 AS-28: an extra property next to reactions is 422; 20 for one emoji is accepted and counts 20', async () => {
    const { stream } = await liveStream();
    const viewer = await t.viewer();
    await t
      .http()
      .post(`/api/live/${stream.id}/reactions`)
      .set(viewer.auth)
      .send({ reactions: { '❤️': 1 }, extra: true })
      .expect(422);
    expect(await t.counters.totals(stream.id, secondNow())).toEqual({});
    await t.react(stream.id, viewer, { '❤️': 20 }).expect(202);
    expect(await t.counters.totals(stream.id, secondNow())).toEqual({
      '❤️': 20,
    });
  });

  // --- AS-29 ------------------------------------------------------------------------------------------------------

  it('S23 AS-29: no credentials is 401, an unknown stream 404, a SCHEDULED or ENDED stream 409 stream_not_live; nothing is counted', async () => {
    const s = await t.seller();
    const viewer = await t.viewer();
    const scheduled = await t.createStream(s);
    const ended = await t.liveStream(s);
    await t.end(s, ended.id).expect(200);
    await t.react(scheduled.id, null, { '❤️': 1 }).expect(401);
    const unknown = await t.react(v4(), viewer, { '❤️': 1 }).expect(404);
    expect(expectProblem(unknown.body).code).toBe('stream_not_found');
    for (const id of [scheduled.id, ended.id]) {
      const res = await t.react(id, await t.viewer(), { '❤️': 1 }).expect(409);
      expect(expectProblem(res.body).code).toBe('stream_not_live');
      expect(await t.counters.totals(id, secondNow())).toEqual({});
    }
  });

  // --- AS-30 ------------------------------------------------------------------------------------------------------

  it('S23 AS-30: the 6th request inside one second is 429 with Retry-After; a limiter that is down accepts', async () => {
    const { stream } = await liveStream();
    const viewer = await t.viewer();
    for (let i = 0; i < 5; i++)
      await t.react(stream.id, viewer, { '❤️': 1 }).expect(202);
    const limited = await t.react(stream.id, viewer, { '❤️': 1 }).expect(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(await t.counters.totals(stream.id, secondNow())).toEqual({
      '❤️': 5,
    });
    t.stores.limiter.down();
    await t.react(stream.id, viewer, { '❤️': 1 }).expect(202);
  });

  // --- AS-31 ------------------------------------------------------------------------------------------------------

  it('S23 AS-31: two publishers over three live streams for 30 seconds publish every second of every stream exactly once', async () => {
    const s = await t.seller();
    const streams = [
      await t.liveStream(s),
      await t.liveStream(s),
      await t.liveStream(s),
    ];
    const other = t.newTicker();
    const start = secondNow();
    for (let i = 0; i < 30; i++) {
      await t.advance(1_000);
      await Promise.all([t.ticker.tick(), other.tick()]);
    }
    for (const stream of streams) {
      const seconds = stats(stream.id).map((x) => x.second);
      expect(seconds).toHaveLength(30);
      expect(new Set(seconds).size).toBe(30);
      expect(Math.min(...seconds)).toBe(start);
    }
    await other.releaseLeases();
  });

  it('S23 AS-31: when the publishing instance stops, the other takes over within 4 seconds', async () => {
    const { stream } = await liveStream();
    const other = t.newTicker();
    await t.advance(1_000);
    await t.ticker.tick();
    expect(stats(stream.id)).toHaveLength(1);
    await t.advance(1_000);
    await other.tick(); // the first instance still holds the lease
    expect(stats(stream.id)).toHaveLength(1);
    const stoppedAt = Date.now(); // the first instance stops (crashes): its lease runs out
    await waitFor(
      async () => {
        await t.advance(1_000);
        await other.tick();
        return stats(stream.id).length >= 2;
      },
      { timeoutMs: 4_000, intervalMs: 20, description: 'takeover' },
    );
    expect(Date.now() - stoppedAt).toBeLessThanOrEqual(4_100);
    await other.releaseLeases();
  });

  it('S23 AS-31: a stream that is not LIVE gets no stats; a stream that ends stops getting them at once', async () => {
    const s = await t.seller();
    const scheduled = await t.createStream(s);
    const running = await t.liveStream(s);
    await t.app.get(RedisService).client.sadd(ACTIVE_STREAMS, scheduled.id);
    await t.advance(1_000);
    await t.ticker.tick();
    expect(stats(scheduled.id)).toHaveLength(0);
    expect(stats(running.id)).toHaveLength(1);
    await t.end(s, running.id).expect(200);
    await t.advance(1_000);
    await t.ticker.tick();
    expect(stats(running.id)).toHaveLength(1);
  });

  it('S23 AS-31: a reaction counted late for a second that was already broadcast is ignored and never added to a later second', async () => {
    const { stream } = await liveStream();
    const second = secondNow();
    await t.counters.add(stream.id, second, { '❤️': 2 });
    await t.advance(1_000);
    await t.ticker.tick();
    await t.counters.add(stream.id, second, { '❤️': 50 }); // late
    await t.advance(1_000);
    await t.ticker.tick();
    await t.advance(1_000);
    await t.ticker.tick();
    expect(stats(stream.id).map((x) => x.reactions)).toEqual([
      { '❤️': 2 },
      {},
      {},
    ]);
  });

  // --- AS-32 ------------------------------------------------------------------------------------------------------

  it('S23 AS-32: a non-empty second is aggregated once even when two publishers run it; an empty second produces none', async () => {
    const { stream } = await liveStream();
    const other = t.newTicker();
    const second = secondNow();
    await t.counters.add(stream.id, second, { '❤️': 3, '🔥': 1 });
    await t.advance(1_000);
    await Promise.all([t.ticker.tick(), other.tick(), t.ticker.tick()]);
    expect(aggregated(stream.id)).toHaveLength(1);
    expect(aggregated(stream.id)[0].payload).toEqual({
      streamId: stream.id,
      second,
      reactions: { '❤️': 3, '🔥': 1 },
    });
    await t.advance(1_000);
    await t.ticker.tick(); // an empty second
    expect(aggregated(stream.id)).toHaveLength(1);
    await other.releaseLeases();
  });
});
