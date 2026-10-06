import { INestApplication } from '@nestjs/common';
import { AddressInfo } from 'node:net';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { readSse } from '@app/test/utils/sse-client';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { LiveCoreModule, LiveWorkerModule, LiveService, LiveTicker, ACTIVE_STREAMS, LiveComment } from '@app/domains/launch-events';
import { LiveGatewayModule } from './live-gateway.module';
import { SAMPLED_PER_TICK } from './live-batcher.service';

/**
 * SD-15 against real Redis: write side (LiveService) → firehose → gateway
 * batcher → SSE; reactions → sharded counters → ticker → `stats`.
 * The API and gateway run in one process here; in production they're separate apps sharing Redis.
 */
describe('Live stream chat (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let live: LiveService;
  let redis: RedisService;
  let seeds: SeedsService;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([LiveCoreModule, LiveGatewayModule, LiveWorkerModule, SeedsModule], { stores: ['redis'] });
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api`;
    live = app.get(LiveService);
    redis = app.get(RedisService);
    seeds = app.get(SeedsService);
    jest.spyOn(app.get(KafkaProducerService), 'send').mockResolvedValue(undefined as never);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
  });

  const goLive = async () => {
    const streamId = v4();
    await redis.client.sadd(ACTIVE_STREAMS, streamId);
    return streamId;
  };

  it('a 600-comment burst reaches a viewer as a few sampled batches; staff comments are never sampled away', async () => {
    const streamId = await goLive();
    await live.comment(streamId, { id: v4(), name: 'early', isStaff: false }, 'first!');

    const reading = readSse(`${baseUrl}/live/${streamId}/events`, { count: 50, timeoutMs: 2_500 });
    await new Promise((r) => setTimeout(r, 300));

    const flood = Array.from({ length: 600 }, (_, i) => live.comment(streamId, { id: v4(), name: `fan${i}`, isStaff: false }, `wow ${i}`));
    await Promise.all([...flood, live.comment(streamId, { id: v4(), name: 'Brand', isStaff: true }, 'Preorders open at 18:00!')]);
    const { events } = await reading;

    const snapshot = JSON.parse(events.find((e) => e.event === 'snapshot')!.data!);
    expect(snapshot.recent.map((c: LiveComment) => c.text)).toEqual(['first!']); // late-joiner history

    const batches = events.filter((e) => e.event === 'comments').map((e) => JSON.parse(e.data!) as { items: LiveComment[]; rate: number });
    const delivered = batches.flatMap((b) => b.items);
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.length).toBeLessThanOrEqual(10); // ≤ 4/s over the ~2 s window
    for (const b of batches) expect(b.items.filter((c) => !c.priority).length).toBeLessThanOrEqual(SAMPLED_PER_TICK);
    expect(delivered.length).toBeLessThan(100); // vs 601 published
    expect(delivered.some((c) => c.text === 'Preorders open at 18:00!')).toBe(true);
    expect(Math.max(...batches.map((b) => b.rate))).toBeGreaterThan(100); // the UI can still say "2.4k comments/s"
  });

  it('reactions are counted, not forwarded: the ticker broadcasts per-second totals and viewer count', async () => {
    const streamId = await goLive();
    const reading = readSse(`${baseUrl}/live/${streamId}/events`, { count: 100, timeoutMs: 7_000 });
    await new Promise((r) => setTimeout(r, 300));

    const second = Math.floor(Date.now() / 1000);
    await Promise.all(Array.from({ length: 200 }, () => live.react(streamId, { '❤️': 3, '🔥': 1 })));
    await live.react(streamId, { '💩': 20 } as never); // not an allowed reaction

    const stats = await app.get(LiveTicker).statsFor(streamId, second, Date.now());
    if (Math.floor(Date.now() / 1000) !== second) {
      // The 200 reactions may straddle a second boundary; then sum both seconds.
      const next = await app.get(LiveTicker).statsFor(streamId, second + 1, Date.now());
      for (const [k, v] of Object.entries(next.reactions)) stats.reactions[k] = (stats.reactions[k] ?? 0) + v;
    }
    expect(stats.reactions).toEqual({ '❤️': 600, '🔥': 200 });

    await new Promise((r) => setTimeout(r, 5_200)); // gateway viewer heartbeat
    await app.get(LiveTicker).tick();
    const { events } = await reading;
    // The background ticker also publishes every second; the latest one reflects the heartbeat.
    const statsEvents = events.filter((e) => e.event === 'stats');
    expect(JSON.parse(statsEvents[statsEvents.length - 1].data!).viewers).toBe(1);
  });

  it('moderation: links are rejected synchronously; removed comments are retracted live; muted users cannot post', async () => {
    const streamId = await goLive();
    const troll = { id: v4(), name: 'troll', isStaff: false };
    await expect(live.comment(streamId, troll, 'cheap iphones at www.example.com')).rejects.toMatchObject({ status: 422 });
    await expect(live.comment(streamId, troll, 'totally n0t a 5c4m')).rejects.toMatchObject({ status: 422 });

    // The background ticker interleaves `stats` events at any moment: stop at the removal, ignore stats.
    const reading = readSse(`${baseUrl}/live/${streamId}/events`, { count: 20, until: ['comment_removed'], timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 300));
    const comment = await live.comment(streamId, troll, 'YOU ARE ALL LOSERS!!!!!!!!');
    await new Promise((r) => setTimeout(r, 400));
    await live.remove(streamId, comment.id, 'auto:0.90');
    const events = (await reading).events.filter((e) => e.event !== 'stats');
    expect(events.map((e) => e.event)).toEqual(['snapshot', 'comments', 'comment_removed']);
    expect(JSON.parse(events[2].data!)).toEqual({ id: comment.id });
    expect((await live.recent(streamId)).map((c) => c.id)).not.toContain(comment.id);

    await live.mute(streamId, troll.id);
    await expect(live.comment(streamId, troll, 'hello?')).rejects.toMatchObject({ status: 403 });
  });
});
