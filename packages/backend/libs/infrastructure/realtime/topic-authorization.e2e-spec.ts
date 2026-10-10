import { problemDetailsSchema } from '@marketplace-sandbox/contracts';
import { waitFor } from '@app/test/utils/async-helpers';
import {
  createRealtimeApp,
  freshId,
  type RealtimeTestApp,
  type RealtimeTestUser,
} from '@app/test/utils/realtime-app';
import { openSse, readSse, type OpenSse } from '@app/test/utils/sse-client';

/** S51 US3 (AS-21 to AS-28): the topic owner's rule decides; refused viewers get nothing. */
describe('S51 authorization (AUTHZ)', () => {
  let rt: RealtimeTestApp;
  let alice: RealtimeTestUser;
  let bob: RealtimeTestUser;
  const open: OpenSse[] = [];
  const track = async (url: string, headers: Record<string, string> = {}) => {
    const stream = await openSse(url, { headers });
    open.push(stream);
    return stream;
  };
  const numsub = async (topic: string) => {
    const [, n] = (await rt.redis.client.pubsub('NUMSUB', `rt:c:${topic}`)) as [
      string,
      number,
    ];
    return Number(n);
  };
  const problem = (body: unknown) => problemDetailsSchema.parse(body);

  beforeAll(async () => {
    rt = await createRealtimeApp({ config: { ruleTimeoutMs: 600 } });
    alice = await rt.newUser();
    bob = await rt.newUser();
  });
  afterAll(async () => {
    await rt.close();
  });
  afterEach(async () => {
    while (open.length) open.pop()!.close();
    await waitFor(async () => rt.hub.channelCount() === 0, {
      timeoutMs: 5_000,
      intervalMs: 25,
    });
  });

  it('S51 AS-21: an owner-only topic is 200 for the owner, 403 for another user, 401 for an anonymous viewer, with no residue', async () => {
    const topic = `user:${alice.id}` as const;
    const owner = await track(rt.url(topic), { authorization: alice.bearer });
    expect(owner.status).toBe(200);

    const other = await readSse(rt.url(topic), {
      headers: { authorization: bob.bearer },
      count: 1,
      timeoutMs: 3_000,
    });
    expect(other.status).toBe(403);
    expect(problem(other.body).code).toBe('forbidden');

    const anonymous = await readSse(rt.url(topic), {
      count: 1,
      timeoutMs: 3_000,
    });
    expect(anonymous.status).toBe(401);
    expect(problem(anonymous.body).code).toBe('unauthenticated');

    // only the owner's subscription exists; the refused requests left nothing
    expect(await numsub(topic)).toBe(1);
    expect(rt.hub.listenerCount()).toBe(1);
  });

  it('S51 AS-22: a public topic is open to an anonymous viewer', async () => {
    const stream = await track(rt.url(`auction:${freshId()}`));
    expect(stream.status).toBe(200);
  });

  it('S51 AS-23: one refused topic refuses the whole connection and subscribes to nothing', async () => {
    const open1 = `auction:${freshId()}` as const;
    const res = await readSse(rt.url(open1, `user:${alice.id}`), {
      headers: { authorization: bob.bearer },
      count: 1,
      timeoutMs: 3_000,
    });
    expect(res.status).toBe(403);
    expect(await numsub(open1)).toBe(0);
    expect(rt.hub.channelCount()).toBe(0);
  });

  it('S51 AS-24: an existing and a missing shop are indistinguishable, and the denial does not name the topic', async () => {
    const existing = freshId();
    rt.fixtures.member(existing, alice.id);
    const missing = freshId();
    const ask = (shop: string) =>
      readSse(rt.url(`shop:${shop}:live`), {
        headers: { authorization: bob.bearer },
        count: 1,
        timeoutMs: 3_000,
      });
    const [a, b] = [await ask(existing), await ask(missing)];

    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const strip = (body: unknown) => {
      const rest = { ...(problem(body) as Record<string, unknown>) };
      delete rest.instance;
      delete rest.requestId;
      delete rest.traceId;
      return rest;
    };
    expect(strip(a.body)).toEqual(strip(b.body));
    expect(JSON.stringify(a.body)).not.toContain(existing);
    const visible = (h: Record<string, unknown>) =>
      Object.keys(h)
        .filter(
          (k) =>
            !['date', 'x-request-id', 'content-length', 'etag'].includes(k),
        )
        .sort();
    expect(visible(a.headers)).toEqual(visible(b.headers));
  });

  it("S51 AS-25: an asynchronous rule decides, and sees the viewer's id and roles", async () => {
    const owner = await readSse(rt.url(`order-export:${alice.id}`), {
      headers: { authorization: alice.bearer },
      count: 1,
      timeoutMs: 600,
    });
    expect(owner.status).toBe(200); // an open stream: the timeout, not a refusal, ended the read
    expect(rt.fixtures.viewers.get(`order-export:${alice.id}`)).toMatchObject({
      userId: alice.id,
      roles: [expect.any(String)],
    });

    const other = await readSse(rt.url(`order-export:${alice.id}`), {
      headers: { authorization: bob.bearer },
      count: 1,
      timeoutMs: 3_000,
    });
    expect(other.status).toBe(403);
  });

  it('S51 AS-26: a rule that throws, or does not answer in time, is 503 — never 403 and never admission', async () => {
    const thrower = freshId();
    const hanger = freshId();
    const denier = freshId();
    rt.fixtures.setMode(thrower, 'throw');
    rt.fixtures.setMode(hanger, 'hang');
    rt.fixtures.setMode(denier, 'deny');

    const thrown = await readSse(rt.url(`gated:${thrower}`), {
      count: 1,
      timeoutMs: 3_000,
    });
    expect(thrown.status).toBe(503);
    expect(problem(thrown.body).code).toBe('realtime_policy_unavailable');

    const started = Date.now();
    const hung = await readSse(rt.url(`gated:${hanger}`), {
      count: 1,
      timeoutMs: 5_000,
    });
    expect(hung.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(2_500);

    // one topic denies, another faults: the fault wins
    const mixed = await readSse(rt.url(`gated:${denier}`, `gated:${thrower}`), {
      count: 1,
      timeoutMs: 3_000,
    });
    expect(mixed.status).toBe(503);
    expect(rt.hub.channelCount()).toBe(0);
  });

  it('S51 AS-27: a rule runs once per topic per connection, never per event', async () => {
    const id = freshId();
    const stream = await track(rt.url(`gated:${id}`));
    for (let n = 0; n < 3; n++)
      await rt.publisher.publish(`gated:${id}`, 'tick', { n });
    await stream.waitFor(
      (f) => f.filter((x) => x.event === 'tick').length === 3,
    );
    expect(rt.fixtures.ruleCalls.get(`gated:${id}`)).toBe(1);

    const second = await track(rt.url(`gated:${id}`));
    expect(second.status).toBe(200);
    expect(rt.fixtures.ruleCalls.get(`gated:${id}`)).toBe(2);
  });

  it('S51 AS-28: an invalid credential is 401 even on a public topic; bearer and cookie both work', async () => {
    const topic = `auction:${freshId()}`;
    for (const authorization of ['Bearer garbage', 'Bearer a.b.c']) {
      const res = await readSse(rt.url(topic), {
        headers: { authorization },
        count: 1,
        timeoutMs: 3_000,
      });
      expect(res.status).toBe(401);
      expect(problem(res.body).code).toBe('unauthenticated');
    }
    const badCookie = await readSse(rt.url(topic), {
      headers: { cookie: '__Host-access=nonsense' },
      count: 1,
      timeoutMs: 3_000,
    });
    expect(badCookie.status).toBe(401);

    const bearer = await track(rt.url(`user:${alice.id}`), {
      authorization: alice.bearer,
    });
    expect(bearer.status).toBe(200);
    const cookie = await track(rt.url(`user:${alice.id}`), {
      cookie: `__Host-access=${alice.bearer.slice('Bearer '.length)}`,
    });
    expect(cookie.status).toBe(200);

    // an expired credential is refused the same way
    rt.clock.advance(24 * 3_600_000);
    try {
      const expired = await readSse(rt.url(topic), {
        headers: { authorization: alice.bearer },
        count: 1,
        timeoutMs: 3_000,
      });
      expect(expired.status).toBe(401);
    } finally {
      rt.clock.set(new Date());
    }
  });
});
