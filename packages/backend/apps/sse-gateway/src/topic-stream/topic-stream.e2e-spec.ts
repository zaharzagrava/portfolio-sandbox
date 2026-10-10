import {
  createRealtimeApp,
  freshId,
  type RealtimeTestApp,
} from '@app/test/utils/realtime-app';
import { openSse, readSse, type OpenSse } from '@app/test/utils/sse-client';
import { waitFor } from '@app/test/utils/async-helpers';

/**
 * The gateway's three original stream scenarios (F-03), kept at their original path after the engine moved into
 * `libs/infrastructure/realtime` (S51 T004). The 12-file suite lives beside the engine; these run the same checks
 * through the same composition the gateway app imports (`RealtimeStreamModule`). Real Redis, no fixed sleeps.
 * The anonymous refusal is 401 now (S51 questions.md, breaking change from 403).
 */
describe('S51 gateway topic streams (e2e, real Redis)', () => {
  let rt: RealtimeTestApp;
  const open: OpenSse[] = [];
  const track = async (url: string, headers: Record<string, string> = {}) => {
    const stream = await openSse(url, { headers });
    open.push(stream);
    return stream;
  };

  beforeAll(async () => {
    rt = await createRealtimeApp();
  });
  afterAll(async () => {
    await rt.close();
  });
  afterEach(async () => {
    while (open.length) open.pop()!.close();
    await waitFor(
      async () => rt.hub.channelCount() === 0 && rt.hub.listenerCount() === 0,
      { timeoutMs: 5_000, intervalMs: 25 },
    );
  });

  it('S51 AS-08: replays exactly the events missed since Last-Event-ID, then continues live', async () => {
    const topic = `auction:${freshId()}` as const;
    const ids: string[] = [];
    for (let price = 1; price <= 5; price++) {
      const { id } = await rt.publisher.publish(topic, 'price', { price });
      ids.push(id!);
    }

    const { events } = await readSse(rt.url(topic), {
      headers: { 'last-event-id': `${topic}~${ids[1]}` },
      count: 3,
    });

    expect(events.map((e) => JSON.parse(e.data!).data.price)).toEqual([
      3, 4, 5,
    ]);
    expect(events.every((e) => e.event === 'price')).toBe(true);
    // The cursor in `id:` lets the next reconnect resume after #5.
    expect(events[2].id).toBe(`${topic}~${ids[4]}`);
  });

  it('S51 AS-01: delivers live events published after connecting', async () => {
    const topic = `auction:${freshId()}` as const;
    const stream = await track(rt.url(topic));
    await rt.publisher.publish(topic, 'comment', { text: 'first' });
    await rt.publisher.publish(topic, 'comment', { text: 'second' });
    await stream.waitFor(
      (frames) => frames.filter((f) => f.event === 'comment').length === 2,
    );

    expect(stream.events.map((e) => JSON.parse(e.data!).data.text)).toEqual([
      'first',
      'second',
    ]);
  });

  it('S51 AS-21: private user topics: owner allowed, others 403, anonymous 401', async () => {
    const alice = await rt.newUser();
    const bob = await rt.newUser();
    const topic = `user:${alice.id}` as const;

    const asBob = await readSse(rt.url(topic), {
      headers: { authorization: bob.bearer },
      count: 1,
      timeoutMs: 2_000,
    });
    expect(asBob.status).toBe(403);

    const anonymous = await readSse(rt.url(topic), {
      count: 1,
      timeoutMs: 2_000,
    });
    expect(anonymous.status).toBe(401);

    const asAlice = await track(rt.url(topic), { authorization: alice.bearer });
    expect(asAlice.status).toBe(200);
    await rt.publisher.publish(topic, 'notification', {
      title: 'Your order shipped',
    });
    await asAlice.waitFor((f) => f.some((x) => x.event === 'notification'));
    expect(JSON.parse(asAlice.events[0].data!).data.title).toBe(
      'Your order shipped',
    );
  });
});
