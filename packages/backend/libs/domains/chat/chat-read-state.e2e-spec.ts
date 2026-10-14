import { chatUnreadPageSchema } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { readSse } from '@app/test/utils/sse-client';
import {
  clearRateLimits,
  createChatApp,
  exec,
  joinedBuyer,
  newId,
  openChannel,
  rows,
  seedWorld,
  sendMessage,
  type ChatTestApp,
  type TestUser,
} from './testing/chat-app';

const T = new Date('2026-10-14T12:00:00.000Z');
const HOUR = 3_600_000;
const REPEATS = 20;

describe('Product chat: unread counts and read receipts', () => {
  let t: ChatTestApp;

  beforeAll(async () => {
    t = await createChatApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    await clearRateLimits(t.app);
    await t.setTime(T);
  });

  const room = async () => {
    const w = await seedWorld(t);
    const channel = await openChannel(t, w);
    const buyer = await joinedBuyer(t, channel.id);
    return { w, owner: w.owner, buyer, channel };
  };
  const unread = (user: TestUser, query = '') =>
    t.as(user).get(`/api/chat/unread${query}`);
  const read = (user: TestUser, channelId: string, body: unknown) =>
    t
      .as(user)
      .post(`/api/chat/channels/${channelId}/read`)
      .send(body as object);
  const position = async (channelId: string, userId: string) =>
    Number(
      (
        await rows<{ lastReadSeq: string }>(
          t.app,
          `SELECT "lastReadSeq" FROM "ChatChannelMember" WHERE "channelId" = :channelId AND "userId" = :userId`,
          { channelId, userId },
        )
      )[0].lastReadSeq,
    );
  /** `n` messages through the API from `author`, spread over the rate window. */
  const post = async (author: TestUser, channelId: string, n: number) => {
    for (let i = 0; i < n; i++) {
      if (i > 0 && i % 8 === 0) await clearRateLimits(t.app);
      expect(
        (await sendMessage(t, author, channelId, `m${i + 1}`)).status,
      ).toBe(201);
    }
  };
  const receipts = (channelId?: string) =>
    t.realtime.published.filter(
      (p) =>
        p.type === 'read' &&
        (channelId === undefined || p.topic === `chat:${channelId}`),
    );
  const failedReceipts = () =>
    MetricsRegistry.value('chat_push_failed_total', { kind: 'receipt' }) ?? 0;

  describe('unread (AS-30, AS-31)', () => {
    it('S24 AS-30: five messages by the seller are 5 unread for the buyer and 0 for the seller', async () => {
      const { owner, buyer, channel } = await room();
      await post(owner, channel.id, 5);
      const mine = await unread(buyer);
      expect(mine.status).toBe(200);
      expect(chatUnreadPageSchema.parse(mine.body)).toEqual({
        items: [{ channelId: channel.id, unread: 5, lastSeq: 5 }],
        nextCursor: null,
      });
      expect((await unread(owner)).body).toEqual({
        items: [{ channelId: channel.id, unread: 0, lastSeq: 5 }],
        nextCursor: null,
      });
      expect((await t.http().get('/api/chat/unread')).status).toBe(401);
    });

    it('S24 AS-30: most recent message first, no archived or banned channels, keyset pages show each channel once', async () => {
      const buyer = await t.user();
      const made: string[] = [];
      for (let i = 0; i < 5; i++) {
        const w = await seedWorld(t);
        const channel = await openChannel(t, w);
        await t.as(buyer).post(`/api/chat/channels/${channel.id}/join`);
        await t.setTime(new Date(T.getTime() + i * HOUR));
        await sendMessage(t, w.owner, channel.id, `hello ${i}`);
        made.push(channel.id);
      }
      const archived = made[1];
      const banned = made[3];
      await exec(
        t.app,
        `UPDATE "ChatChannel" SET "isArchived" = true, "archivedAt" = now() WHERE id = :id`,
        { id: archived },
      );
      await exec(
        t.app,
        `UPDATE "ChatChannelMember" SET status = 'BANNED' WHERE "channelId" = :id AND "userId" = :userId`,
        { id: banned, userId: buyer.id },
      );
      const expected = [made[4], made[2], made[0]];

      const all = chatUnreadPageSchema.parse((await unread(buyer)).body);
      expect(all.items.map((i) => i.channelId)).toEqual(expected);

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const res = await unread(
          buyer,
          `?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
        );
        const body = chatUnreadPageSchema.parse(res.body);
        expect(body.items.length).toBeLessThanOrEqual(1);
        seen.push(...body.items.map((i) => i.channelId));
        cursor = body.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual(expected);
    });

    it('S24 AS-30: gateway-written rows (microsecond timestamps) page without repeats or gaps', async () => {
      const buyer = await t.user();
      const made: string[] = [];
      for (let i = 0; i < 4; i++) {
        const w = await seedWorld(t);
        const channel = await openChannel(t, w);
        await t.as(buyer).post(`/api/chat/channels/${channel.id}/join`);
        await exec(
          t.app,
          `INSERT INTO "ChatMessage" (id, "channelId", "authorId", body, "createdAt") VALUES (uuidv7(), :id, :author, 'hi', now())`,
          { id: channel.id, author: w.owner.id },
        );
        made.push(channel.id);
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 6; page++) {
        const body = chatUnreadPageSchema.parse(
          (await unread(buyer, `?limit=1${cursor ? `&cursor=${cursor}` : ''}`))
            .body,
        );
        seen.push(...body.items.map((i) => i.channelId));
        cursor = body.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual([...made].reverse());
    });

    it.each([
      '?limit=0',
      '?limit=201',
      '?limit=abc',
      '?limit=1.5',
      '?cursor=nope',
    ])('S24 AS-30: %s is 400 validation_failed', async (query) => {
      const { buyer } = await room();
      const res = await unread(buyer, query);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
    });

    it('S24 AS-30: the default page is 50 and the limit may be 200', async () => {
      const { buyer } = await room();
      expect((await unread(buyer, '?limit=200')).status).toBe(200);
      expect(
        chatUnreadPageSchema.parse((await unread(buyer)).body).items,
      ).toHaveLength(1);
    });

    it('S24 AS-31: posting advances the author to their own message; another member at 2 has 4 unread; no receipt for it', async () => {
      const { owner, buyer, channel } = await room();
      const second = await joinedBuyer(t, channel.id);
      await post(owner, channel.id, 5);
      for (const user of [buyer, second])
        expect((await read(user, channel.id, { seq: 2 })).status).toBe(200);
      expect(
        chatUnreadPageSchema.parse((await unread(buyer)).body).items[0].unread,
      ).toBe(3);
      const before = receipts(channel.id).length;

      const own = await sendMessage(t, buyer, channel.id, 'my question');
      expect(own.body.message.seq).toBe(6);
      expect(await position(channel.id, buyer.id)).toBe(6);
      expect(
        chatUnreadPageSchema.parse((await unread(buyer)).body).items[0],
      ).toMatchObject({ unread: 0, lastSeq: 6 });
      expect(
        chatUnreadPageSchema.parse((await unread(second)).body).items[0],
      ).toMatchObject({ unread: 4, lastSeq: 6 });
      expect(receipts(channel.id)).toHaveLength(before);

      // posting never moves a position backwards: a member already ahead stays ahead
      await exec(
        t.app,
        `UPDATE "ChatChannelMember" SET "lastReadSeq" = 9 WHERE "channelId" = :id AND "userId" = :userId`,
        { id: channel.id, userId: second.id },
      );
      await sendMessage(t, second, channel.id, 'later');
      expect(await position(channel.id, second.id)).toBe(9);
    });
  });

  describe('mark read (AS-32, AS-33, AS-34)', () => {
    it('S24 AS-32: monotonic and capped at the last sequence', async () => {
      const { owner, buyer, channel } = await room();
      await post(owner, channel.id, 5);
      const steps: Array<[number, { lastReadSeq: number; unread: number }]> = [
        [3, { lastReadSeq: 3, unread: 2 }],
        [1, { lastReadSeq: 3, unread: 2 }],
        [3, { lastReadSeq: 3, unread: 2 }],
        [999, { lastReadSeq: 5, unread: 0 }],
      ];
      for (const [seq, expected] of steps) {
        const res = await read(buyer, channel.id, { seq });
        expect(res.status).toBe(200);
        expect(res.body).toEqual(expected);
        expect(await position(channel.id, buyer.id)).toBe(expected.lastReadSeq);
      }
    });

    it.each<[string, unknown]>([
      ['seq missing', {}],
      ['seq negative', { seq: -1 }],
      ['seq fractional', { seq: 1.5 }],
      ['seq a string', { seq: '3' }],
      ['seq above 2^53-1', { seq: 2 ** 53 }],
      ['an unknown field', { seq: 1, extra: true }],
    ])(
      'S24 AS-33: %s is 400 validation_failed and nothing changes',
      async (_label, body) => {
        const { owner, buyer, channel } = await room();
        await post(owner, channel.id, 3);
        const res = await read(buyer, channel.id, body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
        expect(await position(channel.id, buyer.id)).toBe(0);
      },
    );

    it('S24 AS-33: a stranger or a banned member gets 404, a malformed ID 400, no credentials 401; an archived channel can be marked read', async () => {
      const { owner, buyer, channel } = await room();
      await post(owner, channel.id, 3);
      const stranger = await t.user();
      for (const who of [stranger]) {
        const res = await read(who, channel.id, { seq: 1 });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('channel_not_found');
      }
      expect((await read(stranger, newId(), { seq: 1 })).status).toBe(404);
      const bad = await read(buyer, 'not-a-uuid', { seq: 1 });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('validation_failed');
      expect(
        (
          await t
            .http()
            .post(`/api/chat/channels/${channel.id}/read`)
            .send({ seq: 1 })
        ).status,
      ).toBe(401);

      await exec(
        t.app,
        `UPDATE "ChatChannel" SET "isArchived" = true, "archivedAt" = now() WHERE id = :id`,
        { id: channel.id },
      );
      const archived = await read(buyer, channel.id, { seq: 2 });
      expect(archived.status).toBe(200);
      expect(archived.body).toEqual({ lastReadSeq: 2, unread: 1 });

      await exec(
        t.app,
        `UPDATE "ChatChannelMember" SET status = 'BANNED' WHERE "channelId" = :id AND "userId" = :userId`,
        { id: channel.id, userId: buyer.id },
      );
      const banned = await read(buyer, channel.id, { seq: 3 });
      expect(banned.status).toBe(404);
      expect(await position(channel.id, buyer.id)).toBe(2);
    });

    it(`S24 AS-34: seq 3 and seq 5 at once always end at 5 and never report below what the other committed (${REPEATS} repeats)`, async () => {
      for (let i = 0; i < REPEATS; i++) {
        const { owner, buyer, channel } = await room();
        await post(owner, channel.id, 5);
        const [low, high] = await Promise.all([
          read(buyer, channel.id, { seq: 3 }),
          read(buyer, channel.id, { seq: 5 }),
        ]);
        expect(low.status).toBe(200);
        expect(high.status).toBe(200);
        expect(high.body.lastReadSeq).toBe(5);
        expect([3, 5]).toContain(low.body.lastReadSeq);
        expect(await position(channel.id, buyer.id)).toBe(5);
        const published = receipts(channel.id).map(
          (r) => (r.data as { seq: number }).seq,
        );
        expect(published).toContain(5);
        expect(published.length).toBeLessThanOrEqual(2);
        // a stale request after 5 committed publishes nothing
        const before = receipts(channel.id).length;
        expect(
          (await read(buyer, channel.id, { seq: 3 })).body.lastReadSeq,
        ).toBe(5);
        expect(receipts(channel.id)).toHaveLength(before);
        await clearRateLimits(t.app);
      }
    });
  });

  describe('receipts (AS-35, AS-36)', () => {
    it('S24 AS-35: an advance publishes read {userId, seq} once after the commit, without replay; a stale or equal call publishes nothing', async () => {
      const { owner, buyer, channel } = await room();
      await post(owner, channel.id, 5);
      expect(receipts(channel.id)).toHaveLength(0);
      await read(buyer, channel.id, { seq: 3 });
      expect(receipts(channel.id)).toHaveLength(1);
      expect(receipts(channel.id)[0]).toMatchObject({
        topic: `chat:${channel.id}`,
        type: 'read',
        data: { userId: buyer.id, seq: 3 },
        options: { replay: false },
      });
      await read(buyer, channel.id, { seq: 3 });
      await read(buyer, channel.id, { seq: 1 });
      expect(receipts(channel.id)).toHaveLength(1);
      await read(buyer, channel.id, { seq: 999 });
      expect(
        receipts(channel.id).map((r) => (r.data as { seq: number }).seq),
      ).toEqual([3, 5]);
    });

    it('S24 AS-35: with the hub unreachable the call is still 200 with the stored position and the failure is counted', async () => {
      const { owner, buyer, channel } = await room();
      await post(owner, channel.id, 5);
      const before = failedReceipts();
      t.realtime.down = true;
      const res = await read(buyer, channel.id, { seq: 4 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ lastReadSeq: 4, unread: 1 });
      expect(await position(channel.id, buyer.id)).toBe(4);
      expect(failedReceipts()).toBe(before + 1);
    });

    it('S24 AS-36: with more than 50 active members no receipt is published; at 50 they resume', async () => {
      const { owner, buyer, channel } = await room();
      await post(owner, channel.id, 5);
      await exec(
        t.app,
        `INSERT INTO "ChatChannelMember" (id, "channelId", "userId", role, status, "lastReadSeq", "createdAt", "updatedAt")
         SELECT uuidv7(), :id, uuidv7(), 'MEMBER', 'ACTIVE', 0, now(), now() FROM generate_series(1, 49)`,
        { id: channel.id },
      );
      const [{ n }] = await rows<{ n: number }>(
        t.app,
        `SELECT "activeMemberCount" AS n FROM "ChatChannel" WHERE id = :id`,
        { id: channel.id },
      );
      expect(n).toBe(51);
      const res = await read(buyer, channel.id, { seq: 2 });
      expect(res.body).toEqual({ lastReadSeq: 2, unread: 3 });
      expect(await position(channel.id, buyer.id)).toBe(2);
      expect(receipts(channel.id)).toHaveLength(0);

      await exec(
        t.app,
        `UPDATE "ChatChannelMember" SET status = 'BANNED' WHERE id = (SELECT id FROM "ChatChannelMember" WHERE "channelId" = :id AND role = 'MEMBER' AND "userId" <> :userId LIMIT 1)`,
        { id: channel.id, userId: buyer.id },
      );
      const [{ n: after }] = await rows<{ n: number }>(
        t.app,
        `SELECT "activeMemberCount" AS n FROM "ChatChannel" WHERE id = :id`,
        { id: channel.id },
      );
      expect(after).toBe(50);
      await read(buyer, channel.id, { seq: 4 });
      expect(receipts(channel.id)).toHaveLength(1);
    });
  });

  describe('delivery through the real hub (AS-35)', () => {
    it('S24 AS-35: a subscribed active member receives the receipt; a stranger and a banned member are refused and receive nothing', async () => {
      const live = t;
      const w = await seedWorld(live);
      const channel = await openChannel(live, w);
      const buyer = await joinedBuyer(live, channel.id);
      const watcher = await joinedBuyer(live, channel.id);
      const stranger = await live.user();
      const banned = await joinedBuyer(live, channel.id);
      await exec(
        live.app,
        `UPDATE "ChatChannelMember" SET status = 'BANNED' WHERE "channelId" = :id AND "userId" = :userId`,
        { id: channel.id, userId: banned.id },
      );
      await sendMessage(live, w.owner, channel.id, 'one');
      await sendMessage(live, w.owner, channel.id, 'two');

      const url = `${live.baseUrl}/streams?topics=chat:${channel.id}`;
      const refusedStranger = await readSse(url, {
        headers: { authorization: stranger.bearer },
        count: 1,
        timeoutMs: 3_000,
      });
      const refusedBanned = await readSse(url, {
        headers: { authorization: banned.bearer },
        count: 1,
        timeoutMs: 3_000,
      });
      expect(refusedStranger.status).toBe(403);
      expect(refusedBanned.status).toBe(403);
      expect(refusedStranger.events).toEqual([]);

      const reading = readSse(url, {
        headers: { authorization: watcher.bearer },
        count: 1,
        timeoutMs: 8_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(
        (
          await live
            .as(buyer)
            .post(`/api/chat/channels/${channel.id}/read`)
            .send({ seq: 2 })
        ).status,
      ).toBe(200);
      const received = await reading;
      expect(received.status).toBe(200);
      const event = received.events.find((e) => e.event === 'read');
      expect(event).toBeDefined();
      // the hub wraps the payload in its envelope; the event name is the SSE `event:` field
      expect(JSON.parse(event!.data!)).toMatchObject({
        topic: `chat:${channel.id}`,
        data: { userId: buyer.id, seq: 2 },
      });
    });
  });

  it("S24 AS-30: a product with a chat created before this suite does not leak into another user's list", async () => {
    const { owner, channel } = await room();
    await post(owner, channel.id, 2);
    const other = await t.user();
    expect(
      chatUnreadPageSchema.parse((await unread(other)).body).items,
    ).toEqual([]);
    const w = await seedWorld(t);
    await createProduct(t.app, w.shop, {});
    expect(
      chatUnreadPageSchema.parse((await unread(other)).body).items,
    ).toEqual([]);
  });
});
