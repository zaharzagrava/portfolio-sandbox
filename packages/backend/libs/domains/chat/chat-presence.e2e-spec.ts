import { presenceResponseSchema } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { recordStatements } from '@app/test/utils/catalog-fixtures';
import { ChatPresenceService } from './application/chat-presence.service';
import {
  clearRateLimits,
  createChatApp,
  exec,
  fastStoreOf,
  joinedBuyer,
  newId,
  openChannel,
  seedWorld,
  type ChatTestApp,
  type FastStore,
  type TestUser,
} from './testing/chat-app';

const T = new Date('2026-10-14T12:00:00.000Z');
const SEC = 1000;

describe('Product chat: presence', () => {
  let t: ChatTestApp;
  let fast: FastStore;

  beforeAll(async () => {
    t = await createChatApp();
    fast = fastStoreOf(t.app);
  });
  afterAll(async () => {
    await fast.allow();
    await t.close();
  });
  beforeEach(async () => {
    await fast.allow();
    await t.reset();
    await clearRateLimits(t.app);
    await t.setTime(T);
  });

  /** Two users sharing a channel. */
  const pair = async () => {
    const w = await seedWorld(t);
    const channel = await openChannel(t, w);
    const buyer = await joinedBuyer(t, channel.id);
    return { owner: w.owner, buyer, channel };
  };
  const heartbeat = (user: TestUser) =>
    t.as(user).post('/api/chat/presence/heartbeat');
  const query = (user: TestUser, ids: string[] | string = '') =>
    t
      .as(user)
      .get(
        `/api/chat/presence${ids === '' ? '' : `?userIds=${Array.isArray(ids) ? ids.join(',') : ids}`}`,
      );
  const at = (ms: number) => t.setTime(new Date(T.getTime() + ms));
  const presenceEvents = () =>
    t.realtime.published.filter((p) => p.type === 'presence');
  const unavailable = () =>
    MetricsRegistry.value('chat_presence_unavailable_total') ?? 0;

  /** `n` channels the user is a member of, most recent message last (so the newest are the last ones made). */
  const channelsOf = async (user: TestUser, n: number) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      if (i % 20 === 0) await clearRateLimits(t.app);
      const w = await seedWorld(t);
      const channel = await openChannel(t, w);
      await t.as(user).post(`/api/chat/channels/${channel.id}/join`);
      await exec(
        t.app,
        `UPDATE "ChatChannel" SET "lastMessageAt" = :at WHERE id = :id`,
        {
          id: channel.id,
          at: new Date(T.getTime() - (n - i) * 60_000),
        },
      );
      ids.push(channel.id);
    }
    return ids;
  };

  describe('online for 60 seconds (AS-37)', () => {
    it('S24 AS-37: a heartbeat is 204; the peer sees online with the heartbeat time; still online at 59 s; offline at 61 s', async () => {
      const { owner, buyer } = await pair();
      expect((await heartbeat(owner)).status).toBe(204);
      const online = await query(buyer, owner.id);
      expect(online.status).toBe(200);
      expect(presenceResponseSchema.parse(online.body)).toEqual({
        [owner.id]: { online: true, lastSeenAt: T.getTime() },
      });

      await at(59 * SEC);
      expect((await query(buyer, owner.id)).body).toEqual({
        [owner.id]: { online: true, lastSeenAt: T.getTime() },
      });
      await at(61 * SEC);
      expect((await query(buyer, owner.id)).body).toEqual({
        [owner.id]: { online: false, lastSeenAt: null },
      });
    });

    it('S24 AS-37: a heartbeat in between restarts the 60 seconds', async () => {
      const { owner, buyer } = await pair();
      await heartbeat(owner);
      await at(40 * SEC);
      await heartbeat(owner);
      await at(95 * SEC);
      expect((await query(buyer, owner.id)).body).toEqual({
        [owner.id]: { online: true, lastSeenAt: T.getTime() + 40 * SEC },
      });
      await at(101 * SEC);
      expect((await query(buyer, owner.id)).body[owner.id].online).toBe(false);
    });
  });

  describe('the first heartbeat is announced once (AS-38)', () => {
    it('S24 AS-38: the offline to online transition goes to exactly the 20 most recently active channels; a second heartbeat 30 s later announces nothing', async () => {
      const user = await t.user();
      const ids = await channelsOf(user, 25);
      const newest20 = ids.slice(5);
      await clearRateLimits(t.app);

      expect((await heartbeat(user)).status).toBe(204);
      const events = presenceEvents();
      expect(events.map((e) => e.topic).sort()).toEqual(
        newest20.map((id) => `chat:${id}`).sort(),
      );
      for (const e of events) {
        expect(e.data).toEqual({
          userId: user.id,
          online: true,
          ttlSeconds: 60,
        });
        expect(e.options).toEqual({ replay: false });
      }

      await at(30 * SEC);
      await heartbeat(user);
      expect(presenceEvents()).toHaveLength(20);
    });

    it('S24 AS-38: twenty first heartbeats at once are one transition: each of the 20 channels gets exactly one event', async () => {
      const user = await t.user();
      const ids = await channelsOf(user, 25);
      const service = t.app.get(ChatPresenceService);
      await Promise.all(
        Array.from({ length: 20 }, () => service.heartbeat(user.id)),
      );
      const topics = presenceEvents().map((e) => e.topic);
      expect(topics).toHaveLength(20);
      expect(new Set(topics)).toEqual(
        new Set(ids.slice(5).map((id) => `chat:${id}`)),
      );
    });

    it('S24 AS-38: after the 60 seconds lapse the next heartbeat is a new transition', async () => {
      const user = await t.user();
      await channelsOf(user, 2);
      await heartbeat(user);
      await at(61 * SEC);
      await heartbeat(user);
      expect(presenceEvents()).toHaveLength(4);
    });

    it('S24 AS-36: a channel with more than 50 active members gets no presence event', async () => {
      const w = await seedWorld(t);
      const huge = await openChannel(t, w);
      const small = await openChannel(t, await seedWorld(t));
      const user = await t.user();
      await t.as(user).post(`/api/chat/channels/${huge.id}/join`);
      await t.as(user).post(`/api/chat/channels/${small.id}/join`);
      await exec(
        t.app,
        `INSERT INTO "ChatChannelMember" (id, "channelId", "userId", role, status, "lastReadSeq", "createdAt", "updatedAt")
         SELECT uuidv7(), :id, uuidv7(), 'MEMBER', 'ACTIVE', 0, now(), now() FROM generate_series(1, 50)`,
        { id: huge.id },
      );
      await heartbeat(user);
      expect(presenceEvents().map((e) => e.topic)).toEqual([
        `chat:${small.id}`,
      ]);
    });
  });

  describe('who may be asked about (AS-39)', () => {
    it('S24 AS-39: a user with no shared channel looks exactly like an offline one; the caller and a peer are answered truthfully', async () => {
      const { owner, buyer } = await pair();
      const other = await pair();
      await heartbeat(other.owner);
      await heartbeat(owner);
      const res = await query(buyer, [other.owner.id, owner.id, buyer.id]);
      expect(res.status).toBe(200);
      expect(presenceResponseSchema.parse(res.body)).toEqual({
        [other.owner.id]: { online: false, lastSeenAt: null },
        [owner.id]: { online: true, lastSeenAt: T.getTime() },
        [buyer.id]: { online: false, lastSeenAt: null },
      });
      await heartbeat(buyer);
      expect((await query(buyer, buyer.id)).body[buyer.id]).toEqual({
        online: true,
        lastSeenAt: T.getTime(),
      });
      const stranger = (await query(buyer, newId())).body;
      expect(Object.values(stranger)[0]).toEqual({
        online: false,
        lastSeenAt: null,
      });
    });

    it('S24 AS-39: more than 100 ids or one that is not a UUID is 400; none is {}; no credentials 401', async () => {
      const { buyer } = await pair();
      const tooMany = await query(
        buyer,
        Array.from({ length: 101 }, () => newId()),
      );
      expect(tooMany.status).toBe(400);
      expect(tooMany.body.code).toBe('validation_failed');
      expect((await query(buyer, [newId(), 'nope'])).status).toBe(400);
      expect(
        (
          await query(
            buyer,
            Array.from({ length: 100 }, () => newId()),
          )
        ).status,
      ).toBe(200);
      for (const empty of [
        await query(buyer),
        await t.as(buyer).get('/api/chat/presence?userIds='),
      ]) {
        expect(empty.status).toBe(200);
        expect(empty.body).toEqual({});
      }
      expect(
        (await t.http().get(`/api/chat/presence?userIds=${newId()}`)).status,
      ).toBe(401);
      expect((await t.http().post('/api/chat/presence/heartbeat')).status).toBe(
        401,
      );
    });
  });

  describe('when the store is down (AS-40)', () => {
    it('S24 AS-40: a heartbeat is 204 and counted, a query is 503 presence_unavailable, and the primary database is never written', async () => {
      const { owner, buyer } = await pair();
      await fast.deny('presence:');
      try {
        const before = unavailable();
        const beat = await recordStatements(
          t.app,
          () => heartbeat(owner),
          /"Chat|presence/i,
        );
        expect(beat.result.status).toBe(204);
        expect(unavailable()).toBe(before + 1);
        expect(
          beat.statements.some((s) => /INSERT|UPDATE|DELETE/i.test(s)),
        ).toBe(false);

        const asked = await query(buyer, owner.id);
        expect(asked.status).toBe(503);
        expect(asked.body.code).toBe('presence_unavailable');
        expect(unavailable()).toBeGreaterThanOrEqual(before + 2);
      } finally {
        await fast.allow();
      }
    });
  });

  describe('heartbeat limit (AS-41)', () => {
    it('S24 AS-41: the 7th heartbeat within a minute is 429 rate_limited with Retry-After and leaves the presence unchanged', async () => {
      const { owner, buyer } = await pair();
      for (let i = 0; i < 6; i++)
        expect((await heartbeat(owner)).status).toBe(204);
      await at(20 * SEC);
      const limited = await heartbeat(owner);
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('rate_limited');
      expect(limited.headers['retry-after']).toBeDefined();
      expect((await query(buyer, owner.id)).body).toEqual({
        [owner.id]: { online: true, lastSeenAt: T.getTime() },
      });
    });
  });
});
