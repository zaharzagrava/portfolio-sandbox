import {
  chatInboxPageSchema,
  chatReceiptsSchema,
} from '@marketplace-sandbox/contracts';
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

/** W05 backend additions: the inbox (B-1), hub hints (B-2) and receipts (B-3). */
describe('Product chat: inbox, hub hints and receipts for the web client', () => {
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

  const mine = (user: TestUser, query = '') =>
    t.as(user).get(`/api/chat/channels/mine${query}`);
  const receipts = (user: TestUser, channelId: string) =>
    t.as(user).get(`/api/chat/channels/${channelId}/receipts`);
  const hints = (channelId: string, type?: string) =>
    t.realtime.published.filter(
      (p) =>
        p.topic === `chat:${channelId}` &&
        (type === undefined ? p.type !== 'read' && p.type !== 'presence' : p.type === type),
    );
  const room = async () => {
    const w = await seedWorld(t);
    const channel = await openChannel(t, w);
    const buyer = await joinedBuyer(t, channel.id);
    return { w, owner: w.owner, buyer, channel };
  };

  describe('GET /chat/channels/mine (B-1)', () => {
    it('W05 AS-07: lists the caller\'s chats with title, unread equal to /chat/unread, lastSeq and lastMessageAt', async () => {
      const { owner, buyer, channel } = await room();
      await sendMessage(t, owner, channel.id, 'one');
      await sendMessage(t, owner, channel.id, 'two');
      const res = await mine(buyer);
      expect(res.status).toBe(200);
      const page = chatInboxPageSchema.parse(res.body);
      expect(page.nextCursor).toBeNull();
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        id: channel.id,
        title: channel.title,
        unread: 2,
        lastSeq: 2,
        myRole: 'MEMBER',
      });
      expect(page.items[0].lastMessageAt).toBe(T.toISOString());
      const unread = await t.as(buyer).get('/api/chat/unread');
      expect(unread.body.items[0].unread).toBe(page.items[0].unread);
    });

    it('W05 AS-07: newest message first with channels that have none last, archived chats after the active ones, and keyset pages show each once', async () => {
      const buyer = await t.user();
      const made: string[] = [];
      for (let i = 0; i < 5; i++) {
        const w = await seedWorld(t);
        const channel = await openChannel(t, w);
        await t.as(buyer).post(`/api/chat/channels/${channel.id}/join`);
        made.push(channel.id);
        if (i === 4) continue; // never written to: lastMessageAt null
        await t.setTime(new Date(T.getTime() + i * HOUR));
        await sendMessage(t, w.owner, channel.id, `hello ${i}`);
      }
      await exec(
        t.app,
        `UPDATE "ChatChannel" SET "isArchived" = true, "archivedAt" = now() WHERE id = :id`,
        { id: made[3] },
      );
      const expected = [made[2], made[1], made[0], made[4], made[3]];
      const first = chatInboxPageSchema.parse((await mine(buyer, '?limit=2')).body);
      expect(first.items.map((c) => c.id)).toEqual(expected.slice(0, 2));
      expect(first.nextCursor).not.toBeNull();
      const second = chatInboxPageSchema.parse(
        (await mine(buyer, `?limit=2&cursor=${first.nextCursor}`)).body,
      );
      expect(second.items.map((c) => c.id)).toEqual(expected.slice(2, 4));
      const third = chatInboxPageSchema.parse(
        (await mine(buyer, `?limit=2&cursor=${second.nextCursor}`)).body,
      );
      expect(third.items.map((c) => c.id)).toEqual(expected.slice(4));
      expect(third.nextCursor).toBeNull();
      expect(third.items[0].isArchived).toBe(true);
    });

    it('W05 AS-07: only the caller\'s own active memberships are listed', async () => {
      const { channel } = await room();
      const stranger = await t.user();
      expect(chatInboxPageSchema.parse((await mine(stranger)).body).items).toEqual([]);
      const { buyer } = await room();
      await exec(
        t.app,
        `UPDATE "ChatChannelMember" SET status = 'BANNED' WHERE "channelId" = :id AND "userId" = :userId`,
        { id: channel.id, userId: buyer.id },
      );
      const items = chatInboxPageSchema.parse((await mine(buyer)).body).items;
      expect(items.map((c) => c.id)).not.toContain(channel.id);
    });

    it.each(['?limit=0', '?limit=101', '?limit=abc', '?cursor=%25%25bad'])(
      'W05 AS-07: %s is 400 validation_failed',
      async (query) => {
        const { buyer } = await room();
        const res = await mine(buyer, query);
        expect(res.status).toBe(400);
      },
    );

    it('W05 AS-07: no credentials is 401', async () => {
      expect((await t.http().get('/api/chat/channels/mine')).status).toBe(401);
    });
  });

  describe('hub hints (B-2)', () => {
    it('W05 AS-23: a created message publishes one message hint on chat:<id> without replay; an identical replay publishes none', async () => {
      const { owner, channel } = await room();
      const key = newId();
      const first = await sendMessage(t, owner, channel.id, 'hi', { clientMessageId: key });
      expect(first.status).toBe(201);
      const sent = hints(channel.id, 'message');
      expect(sent).toHaveLength(1);
      expect(sent[0].data).toEqual({
        channelId: channel.id,
        messageId: first.body.message.id,
        seq: first.body.message.seq,
      });
      expect(sent[0].options).toMatchObject({ replay: false });
      const replay = await sendMessage(t, owner, channel.id, 'hi', { clientMessageId: key });
      expect(replay.status).toBe(200);
      expect(hints(channel.id, 'message')).toHaveLength(1);
    });

    it('W05 AS-23: a refused write publishes nothing, and a hub that is down never fails the write', async () => {
      const { owner, buyer, channel } = await room();
      await exec(
        t.app,
        `UPDATE "ChatChannelMember" SET status = 'BANNED' WHERE "channelId" = :id AND "userId" = :userId`,
        { id: channel.id, userId: buyer.id },
      );
      expect((await sendMessage(t, buyer, channel.id, 'nope')).status).toBe(403);
      expect(hints(channel.id)).toHaveLength(0);
      t.realtime.down = true;
      expect((await sendMessage(t, owner, channel.id, 'still works')).status).toBe(201);
    });

    it('W05 AS-23: a delete publishes one message_deleted hint, a repeated delete none', async () => {
      const { owner, channel } = await room();
      const sent = await sendMessage(t, owner, channel.id, 'regret');
      const id = sent.body.message.id as string;
      const del = () => t.as(owner).delete(`/api/chat/channels/${channel.id}/messages/${id}`);
      expect((await del()).status).toBe(204);
      expect(hints(channel.id, 'message_deleted').map((h) => h.data)).toEqual([
        { channelId: channel.id, messageId: id },
      ]);
      expect((await del()).status).toBe(204);
      expect(hints(channel.id, 'message_deleted')).toHaveLength(1);
    });

    it('W05 AS-27: archiving publishes one channel_archived hint, unarchiving none', async () => {
      const { owner, channel } = await room();
      const patch = (isArchived: boolean) =>
        t.as(owner).patch(`/api/chat/channels/${channel.id}`).send({ isArchived });
      expect((await patch(true)).status).toBe(200);
      expect(hints(channel.id, 'channel_archived').map((h) => h.data)).toEqual([
        { channelId: channel.id },
      ]);
      expect((await patch(false)).status).toBe(200);
      expect(hints(channel.id, 'channel_archived')).toHaveLength(1);
    });
  });

  describe('GET /chat/channels/:id/receipts (B-3)', () => {
    it('W05 AS-33: lists the read position of every active member', async () => {
      const { owner, buyer, channel } = await room();
      await sendMessage(t, owner, channel.id, 'a');
      await sendMessage(t, owner, channel.id, 'b');
      await t.as(buyer).post(`/api/chat/channels/${channel.id}/read`).send({ seq: 1 });
      const res = await receipts(owner, channel.id);
      expect(res.status).toBe(200);
      const body = chatReceiptsSchema.parse(res.body);
      expect(body.suppressed).toBe(false);
      const byUser = Object.fromEntries(body.items.map((i) => [i.userId, i.lastReadSeq]));
      expect(byUser[buyer.id]).toBe(1);
      expect(byUser[owner.id]).toBe(2);
    });

    it('W05 AS-33: a banned member is not listed', async () => {
      const { owner, buyer, channel } = await room();
      await exec(
        t.app,
        `UPDATE "ChatChannelMember" SET status = 'BANNED' WHERE "channelId" = :id AND "userId" = :userId`,
        { id: channel.id, userId: buyer.id },
      );
      const body = chatReceiptsSchema.parse((await receipts(owner, channel.id)).body);
      expect(body.items.map((i) => i.userId)).not.toContain(buyer.id);
    });

    it('W05 AS-35: above 50 active members the answer is suppressed with no items', async () => {
      const { owner, channel } = await room();
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
      const body = chatReceiptsSchema.parse((await receipts(owner, channel.id)).body);
      expect(body).toEqual({ items: [], suppressed: true });
    });

    it('W05 AS-33: a stranger gets 404, a malformed id 400, no credentials 401', async () => {
      const { channel } = await room();
      const stranger = await t.user();
      expect((await receipts(stranger, channel.id)).status).toBe(404);
      expect((await receipts(stranger, 'not-a-uuid')).status).toBe(400);
      expect((await t.http().get(`/api/chat/channels/${channel.id}/receipts`)).status).toBe(401);
    });
  });
});
