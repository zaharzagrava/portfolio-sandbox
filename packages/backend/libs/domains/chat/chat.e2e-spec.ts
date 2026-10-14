import {
  chatChannelSchema,
  chatChannelSyncSchema,
  chatUnreadPageSchema,
  chatWsTicketSchema,
} from '@marketplace-sandbox/contracts';
import { z } from 'zod';
import {
  clearRateLimits,
  createChatApp,
  openChannel,
  rows,
  seedWorld,
  sendMessage,
  type ChatTestApp,
} from './testing/chat-app';

const T = new Date('2026-10-14T12:00:00.000Z');

/**
 * The journey across the routes (the old `chat.e2e-spec.ts` smoke, rebuilt over the new contracts): what a seller and a
 * buyer do in one conversation, each step through HTTP only. The detail of every step is proven in the scenario files
 * of `test-plan.md`; this file proves they work together.
 */
describe('Product chat: one conversation from the first question to the last read', () => {
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

  it('S24 AS-09: the seller opens the chat, the buyer joins and asks, the seller answers, and the buyer catches up, reads and is current', async () => {
    const w = await seedWorld(t, { title: 'Phone 17' });
    const opened = await t
      .as(w.owner)
      .post('/api/chat/channels')
      .send({ productId: w.product.id });
    expect(opened.status).toBe(201);
    const channel = chatChannelSchema.parse(opened.body);
    expect(channel).toMatchObject({
      title: 'Phone 17',
      myRole: 'OWNER',
      shopId: w.shop.id,
    });

    const buyer = await t.user();
    const found = await t
      .as(buyer)
      .get(`/api/chat/channels/by-product/${w.product.id}`);
    expect(found.status).toBe(200);
    expect(found.body.myRole).toBeNull();
    const joined = await t
      .as(buyer)
      .post(`/api/chat/channels/${channel.id}/join`);
    expect(joined.status).toBe(200);
    expect(joined.body.myRole).toBe('MEMBER');

    const question = await sendMessage(t, buyer, channel.id, 'Is it unlocked?');
    expect(question.status).toBe(201);
    expect(question.body.message.seq).toBe(1);
    const answer = await sendMessage(
      t,
      w.owner,
      channel.id,
      'Yes, any network.',
      {
        replyToId: question.body.message.id,
      },
    );
    expect(answer.status).toBe(201);
    expect(answer.body.message).toMatchObject({
      seq: 2,
      replyToId: question.body.message.id,
    });

    // the buyer reconnects with the highest sequence they hold and gets the answer
    const synced = z.array(chatChannelSyncSchema).parse(
      (
        await t
          .as(buyer)
          .post('/api/chat/sync')
          .send({ cursors: { [channel.id]: 1 } })
      ).body,
    );
    expect(synced).toHaveLength(1);
    expect(synced[0].messages.map((m) => m.body)).toEqual([
      'Yes, any network.',
    ]);
    expect(synced[0]).toMatchObject({ lastSeq: 2, hasMore: false });

    const before = chatUnreadPageSchema.parse(
      (await t.as(buyer).get('/api/chat/unread')).body,
    );
    expect(before.items).toEqual([
      { channelId: channel.id, unread: 1, lastSeq: 2 },
    ]);
    const read = await t
      .as(buyer)
      .post(`/api/chat/channels/${channel.id}/read`)
      .send({ seq: 2 });
    expect(read.body).toEqual({ lastReadSeq: 2, unread: 0 });
    expect(
      t.realtime.published.filter(
        (p) => p.type === 'read' && p.topic === `chat:${channel.id}`,
      ),
    ).toHaveLength(1);
    const after = chatUnreadPageSchema.parse(
      (await t.as(buyer).get('/api/chat/unread')).body,
    );
    expect(after.items[0].unread).toBe(0);
    // posting moved the seller's own position to their answer, so nothing is unread for them (AS-31)
    const sellerUnread = chatUnreadPageSchema.parse(
      (await t.as(w.owner).get('/api/chat/unread')).body,
    );
    expect(sellerUnread.items[0].unread).toBe(0);

    const stored = await rows<{ seq: string; body: string }>(
      t.app,
      `SELECT seq, body FROM "ChatMessage" WHERE "channelId" = :id ORDER BY seq`,
      { id: channel.id },
    );
    expect(stored.map((m) => [m.seq, m.body])).toEqual([
      ['1', 'Is it unlocked?'],
      ['2', 'Yes, any network.'],
    ]);
  });

  it('S24 AS-55: a signed-in user gets a gateway ticket for the realtime socket', async () => {
    const user = await t.user();
    const res = await t.as(user).post('/api/chat/ws-ticket');
    expect(res.status).toBe(201);
    const ticket = chatWsTicketSchema.parse(res.body);
    expect(ticket.ticket.split('.')).toHaveLength(3);
    expect(ticket.expiresAt).toBe(new Date(T.getTime() + 60_000).toISOString());
  });

  it("S24 AS-02: a user who is not in the seller's shop cannot open a chat for the product", async () => {
    const w = await seedWorld(t);
    const stranger = await t.user();
    const res = await t
      .as(stranger)
      .post('/api/chat/channels')
      .send({ productId: w.product.id });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('permission_denied');
  });

  it('S24 AS-51: the owner mutes a member, who can read but not write until the mute lapses', async () => {
    const w = await seedWorld(t);
    const channel = await openChannel(t, w);
    const buyer = await t.user();
    await t.as(buyer).post(`/api/chat/channels/${channel.id}/join`);
    const muted = await t
      .as(w.owner)
      .post(`/api/chat/channels/${channel.id}/members/mute`)
      .send({ userId: buyer.id, minutes: 5 });
    expect(muted.status).toBe(204);
    const blocked = await sendMessage(t, buyer, channel.id, 'hello?');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('muted');
    expect(
      (await t.as(buyer).get(`/api/chat/channels/${channel.id}/messages`))
        .status,
    ).toBe(200);
    await t.setTime(new Date(T.getTime() + 6 * 60_000));
    expect((await sendMessage(t, buyer, channel.id, 'hello?')).status).toBe(
      201,
    );
  });

  it('S24 AS-06: joining twice is harmless and a ban sticks', async () => {
    const w = await seedWorld(t);
    const channel = await openChannel(t, w);
    const buyer = await t.user();
    expect(
      (await t.as(buyer).post(`/api/chat/channels/${channel.id}/join`)).status,
    ).toBe(200);
    expect(
      (await t.as(buyer).post(`/api/chat/channels/${channel.id}/join`)).status,
    ).toBe(200);
    expect(
      (
        await t
          .as(w.owner)
          .post(`/api/chat/channels/${channel.id}/members/ban`)
          .send({ userId: buyer.id })
      ).status,
    ).toBe(204);
    const again = await t
      .as(buyer)
      .post(`/api/chat/channels/${channel.id}/join`);
    expect(again.status).toBe(403);
    expect(again.body.code).toBe('banned');
  });
});
