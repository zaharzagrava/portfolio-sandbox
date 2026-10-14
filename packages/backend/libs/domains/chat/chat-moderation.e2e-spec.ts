import {
  chatMessagePageSchema,
  chatWsTicketSchema,
  chatChannelSyncSchema,
} from '@marketplace-sandbox/contracts';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { ApiConfigService } from '@app/common/config';
import { addMember } from '@app/test/utils/tenancy-fixtures';
import {
  addShopMember,
  clearRateLimits,
  createChatApp,
  exec,
  joinedBuyer,
  newId,
  openChannel,
  rows,
  seedWorld,
  sendMessage,
  type ChannelBody,
  type ChatTestApp,
  type ChatWorld,
  type TestUser,
} from './testing/chat-app';

const T = new Date('2026-10-14T12:00:00.000Z');
const MIN = 60_000;
const REPEATS = 20;

describe('Product chat: moderation, message deletion and gateway tickets', () => {
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

  interface Squad {
    w: ChatWorld;
    owner: TestUser;
    channel: ChannelBody;
    /** A stored MODERATOR. */
    moderator: TestUser;
    members: TestUser[];
  }
  /** A channel with its shop owner, one promoted moderator and two plain members. */
  const squad = async (): Promise<Squad> => {
    const w = await seedWorld(t);
    const channel = await openChannel(t, w);
    const moderator = await joinedBuyer(t, channel.id);
    const members = [
      await joinedBuyer(t, channel.id),
      await joinedBuyer(t, channel.id),
    ];
    await exec(
      t.app,
      `UPDATE "ChatChannelMember" SET role = 'MODERATOR' WHERE "channelId" = :id AND "userId" = :userId`,
      {
        id: channel.id,
        userId: moderator.id,
      },
    );
    return { w, owner: w.owner, channel, moderator, members };
  };
  const act = (
    actor: TestUser,
    channelId: string,
    action: string,
    body: unknown,
  ) =>
    t
      .as(actor)
      .post(`/api/chat/channels/${channelId}/members/${action}`)
      .send(body as object);
  const member = async (channelId: string, userId: string) =>
    (
      await rows<{
        role: string;
        status: string;
        mutedUntil: Date | null;
        lastReadSeq: string;
      }>(
        t.app,
        `SELECT role::text AS role, status::text AS status, "mutedUntil", "lastReadSeq" FROM "ChatChannelMember" WHERE "channelId" = :channelId AND "userId" = :userId`,
        { channelId, userId },
      )
    )[0];
  const moderationEvents = () => t.live.moderation;
  const del = (actor: TestUser, channelId: string, messageId: string) =>
    t.as(actor).delete(`/api/chat/channels/${channelId}/messages/${messageId}`);

  describe('ban and unban (AS-49)', () => {
    it('S24 AS-49: staff ban a member (204) who then cannot send, join or read; a repeat is 409 invalid_transition', async () => {
      const { owner, channel, members } = await squad();
      const [target] = members;
      const res = await act(owner, channel.id, 'ban', { userId: target.id });
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect((await member(channel.id, target.id)).status).toBe('BANNED');
      expect(moderationEvents()).toEqual([
        { type: 'ban', channelId: channel.id, userId: target.id },
      ]);

      expect((await sendMessage(t, target, channel.id, 'hi')).body.code).toBe(
        'banned',
      );
      expect(
        (await t.as(target).post(`/api/chat/channels/${channel.id}/join`)).body
          .code,
      ).toBe('banned');
      expect(
        (await t.as(target).get(`/api/chat/channels/${channel.id}/messages`))
          .status,
      ).toBe(403);

      const again = await act(owner, channel.id, 'ban', { userId: target.id });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('invalid_transition');
      expect(moderationEvents()).toHaveLength(1);
    });

    it('S24 AS-49: unban restores ACTIVE and leaves role and read position alone; unbanning an active member is 409', async () => {
      const { owner, moderator, channel, members } = await squad();
      const [target] = members;
      await sendMessage(t, owner, channel.id, 'one');
      await t
        .as(target)
        .post(`/api/chat/channels/${channel.id}/read`)
        .send({ seq: 1 });
      await act(moderator, channel.id, 'ban', { userId: target.id });
      const before = await member(channel.id, target.id);
      const res = await act(moderator, channel.id, 'unban', {
        userId: target.id,
      });
      expect(res.status).toBe(204);
      const after = await member(channel.id, target.id);
      expect(after).toMatchObject({
        status: 'ACTIVE',
        role: before.role,
        lastReadSeq: before.lastReadSeq,
      });
      expect(moderationEvents().map((e) => e.type)).toEqual(['ban', 'unban']);
      const twice = await act(moderator, channel.id, 'unban', {
        userId: target.id,
      });
      expect(twice.status).toBe(409);
      expect(twice.body.code).toBe('invalid_transition');
    });

    it('S24 AS-49: no credentials is 401', async () => {
      const { channel, members } = await squad();
      expect(
        (
          await t
            .http()
            .post(`/api/chat/channels/${channel.id}/members/ban`)
            .send({ userId: members[0].id })
        ).status,
      ).toBe(401);
    });
  });

  describe('rank (AS-50)', () => {
    it('S24 AS-50: a moderator cannot act on another moderator, on shop staff, or on themselves; nothing changes', async () => {
      const { w, owner, moderator, channel } = await squad();
      const second = await joinedBuyer(t, channel.id);
      await exec(
        t.app,
        `UPDATE "ChatChannelMember" SET role = 'MODERATOR' WHERE "channelId" = :id AND "userId" = :userId`,
        { id: channel.id, userId: second.id },
      );
      const staff = await addShopMember(t, w.shop.id, 'STAFF');
      await t.as(staff).post(`/api/chat/channels/${channel.id}/join`);
      for (const target of [second, staff, moderator, owner]) {
        const res = await act(moderator, channel.id, 'ban', {
          userId: target.id,
        });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('permission_denied');
      }
      expect((await member(channel.id, second.id)).status).toBe('ACTIVE');
      expect(moderationEvents()).toEqual([]);
    });

    it('S24 AS-50: staff cannot act on themselves or on other staff either', async () => {
      const { w, owner, channel } = await squad();
      const staff = await addShopMember(t, w.shop.id, 'STAFF');
      await t.as(staff).post(`/api/chat/channels/${channel.id}/join`);
      expect(
        (await act(owner, channel.id, 'ban', { userId: owner.id })).status,
      ).toBe(403);
      expect(
        (await act(owner, channel.id, 'ban', { userId: staff.id })).status,
      ).toBe(403);
      expect((await member(channel.id, staff.id)).status).toBe('ACTIVE');
    });

    it('S24 AS-50: a plain member is 403 on every moderation route', async () => {
      const { channel, members } = await squad();
      const [plain, other] = members;
      for (const [action, body] of [
        ['ban', { userId: other.id }],
        ['unban', { userId: other.id }],
        ['mute', { userId: other.id, minutes: 5 }],
        ['unmute', { userId: other.id }],
        ['promote', { userId: other.id }],
        ['demote', { userId: other.id }],
      ] as const) {
        const res = await act(plain, channel.id, action, body);
        expect([action, res.status, res.body.code]).toEqual([
          action,
          403,
          'permission_denied',
        ]);
      }
      expect(await member(channel.id, other.id)).toMatchObject({
        status: 'ACTIVE',
        role: 'MEMBER',
      });
    });

    it('S24 AS-50: a target who is not a member is 404 member_not_found and no membership is created; a stranger caller is 404 channel_not_found', async () => {
      const { owner, channel } = await squad();
      const outsider = await t.user();
      const res = await act(owner, channel.id, 'ban', { userId: outsider.id });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('member_not_found');
      expect(
        (await act(owner, channel.id, 'ban', { userId: newId() })).body.code,
      ).toBe('member_not_found');
      expect(await member(channel.id, outsider.id)).toBeUndefined();
      const hidden = await act(outsider, channel.id, 'ban', {
        userId: owner.id,
      });
      expect(hidden.status).toBe(404);
      expect(hidden.body.code).toBe('channel_not_found');
    });

    it.each<[string, unknown]>([
      ['a missing userId', {}],
      ['a userId that is not a UUID', { userId: 'nope' }],
      ['an unknown field', { userId: newId(), extra: 1 }],
    ])('S24 AS-50: %s is 400 validation_failed', async (_label, body) => {
      const { owner, channel } = await squad();
      const res = await act(owner, channel.id, 'ban', body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
    });
  });

  describe('mute and unmute (AS-51)', () => {
    it('S24 AS-51: mute sets mutedUntil from the clock, publishes it, blocks sending but not reading; a second mute replaces it', async () => {
      const { moderator, channel, members } = await squad();
      const [target] = members;
      const res = await act(moderator, channel.id, 'mute', {
        userId: target.id,
        minutes: 10,
      });
      expect(res.status).toBe(204);
      expect(
        (await member(channel.id, target.id)).mutedUntil?.toISOString(),
      ).toBe(new Date(T.getTime() + 10 * MIN).toISOString());
      expect(moderationEvents()).toEqual([
        {
          type: 'mute',
          channelId: channel.id,
          userId: target.id,
          mutedUntil: new Date(T.getTime() + 10 * MIN).toISOString(),
        },
      ]);
      expect(
        (await sendMessage(t, target, channel.id, 'hi')).body,
      ).toMatchObject({ code: 'muted' });
      expect(
        (await t.as(target).get(`/api/chat/channels/${channel.id}/messages`))
          .status,
      ).toBe(200);

      await t.setTime(new Date(T.getTime() + 3 * MIN));
      expect(
        (
          await act(moderator, channel.id, 'mute', {
            userId: target.id,
            minutes: 60,
          })
        ).status,
      ).toBe(204);
      expect(
        (await member(channel.id, target.id)).mutedUntil?.toISOString(),
      ).toBe(new Date(T.getTime() + 63 * MIN).toISOString());
    });

    it.each<[string, unknown]>([
      ['minutes 0', { minutes: 0 }],
      ['minutes 43,201', { minutes: 43_201 }],
      ['fractional minutes', { minutes: 1.5 }],
      ['minutes missing', {}],
      ['minutes a string', { minutes: '5' }],
    ])('S24 AS-51: %s is 400 validation_failed', async (_label, extra) => {
      const { moderator, channel, members } = await squad();
      const res = await act(moderator, channel.id, 'mute', {
        userId: members[0].id,
        ...(extra as object),
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
      expect((await member(channel.id, members[0].id)).mutedUntil).toBeNull();
    });

    it('S24 AS-51: unmute clears an active mute and publishes it; unmuting someone not muted is 409', async () => {
      const { moderator, channel, members } = await squad();
      const [target] = members;
      await act(moderator, channel.id, 'mute', {
        userId: target.id,
        minutes: 10,
      });
      const res = await act(moderator, channel.id, 'unmute', {
        userId: target.id,
      });
      expect(res.status).toBe(204);
      expect((await member(channel.id, target.id)).mutedUntil).toBeNull();
      expect(moderationEvents().map((e) => e.type)).toEqual(['mute', 'unmute']);
      const again = await act(moderator, channel.id, 'unmute', {
        userId: target.id,
      });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('invalid_transition');
      // a mute that has already run out is not "muted" any more
      await act(moderator, channel.id, 'mute', {
        userId: target.id,
        minutes: 1,
      });
      await t.setTime(new Date(T.getTime() + 2 * MIN));
      expect(
        (await act(moderator, channel.id, 'unmute', { userId: target.id }))
          .status,
      ).toBe(409);
    });
  });

  describe('promote and demote (AS-52)', () => {
    it('S24 AS-52: staff promote a MEMBER and demote a MODERATOR; others are 403; repeats are 409', async () => {
      const { owner, moderator, channel, members } = await squad();
      const [target] = members;
      expect(
        (await act(moderator, channel.id, 'promote', { userId: target.id }))
          .status,
      ).toBe(403);
      expect(
        (await act(target, channel.id, 'promote', { userId: members[1].id }))
          .status,
      ).toBe(403);
      expect(
        (await act(owner, channel.id, 'promote', { userId: target.id })).status,
      ).toBe(204);
      expect((await member(channel.id, target.id)).role).toBe('MODERATOR');
      expect(moderationEvents().map((e) => e.type)).toEqual(['promote']);
      const again = await act(owner, channel.id, 'promote', {
        userId: target.id,
      });
      expect([again.status, again.body.code]).toEqual([
        409,
        'invalid_transition',
      ]);

      expect(
        (await act(moderator, channel.id, 'demote', { userId: target.id }))
          .status,
      ).toBe(403);
      expect(
        (await act(owner, channel.id, 'demote', { userId: target.id })).status,
      ).toBe(204);
      expect((await member(channel.id, target.id)).role).toBe('MEMBER');
      const twice = await act(owner, channel.id, 'demote', {
        userId: target.id,
      });
      expect([twice.status, twice.body.code]).toEqual([
        409,
        'invalid_transition',
      ]);
      expect(moderationEvents().map((e) => e.type)).toEqual([
        'promote',
        'demote',
      ]);
    });

    it('S24 AS-52: the stored OWNER role is never changed by an action', async () => {
      const w = await seedWorld(t);
      const creator = await addShopMember(t, w.shop.id, 'STAFF');
      const created = await t
        .as(creator)
        .post('/api/chat/channels')
        .send({ productId: w.product.id });
      const channelId = created.body.id as string;
      // the creator leaves the shop, so only their stored OWNER role is left, with no authority behind it
      expect(
        (
          await t
            .as(w.owner)
            .delete(`/api/shops/${w.shop.id}/members/${creator.id}`)
        ).status,
      ).toBeLessThan(300);
      for (const action of ['promote', 'demote'] as const) {
        const res = await act(w.owner, channelId, action, {
          userId: creator.id,
        });
        expect([action, res.status, res.body.code]).toEqual([
          action,
          409,
          'invalid_transition',
        ]);
      }
      expect((await member(channelId, creator.id)).role).toBe('OWNER');
    });
  });

  describe('delete a message (AS-53)', () => {
    it('S24 AS-53: an author deletes their own message: 204, a tombstone that keeps its sequence, who and when recorded, one live event', async () => {
      const { owner, channel, members } = await squad();
      const [author] = members;
      const sent = await sendMessage(t, author, channel.id, 'regret');
      const id = sent.body.message.id as string;
      const res = await del(author, channel.id, id);
      expect(res.status).toBe(204);
      const [row] = await rows<{
        deletedAt: Date;
        deletedBy: string;
        seq: string;
      }>(
        t.app,
        `SELECT "deletedAt", "deletedBy", seq FROM "ChatMessage" WHERE id = :id`,
        { id },
      );
      expect(row.deletedBy).toBe(author.id);
      expect(row.deletedAt.toISOString()).toBe(T.toISOString());
      expect(row.seq).toBe('1');
      expect(t.live.eventsOf(channel.id, 'message_deleted')).toEqual([
        { type: 'message_deleted', channelId: channel.id, messageId: id },
      ]);

      const page = chatMessagePageSchema.parse(
        (await t.as(owner).get(`/api/chat/channels/${channel.id}/messages`))
          .body,
      );
      expect(page.items[0]).toMatchObject({
        id,
        seq: 1,
        deleted: true,
        body: null,
      });
    });

    it('S24 AS-53: a delete is visible in the very next sync even after a warm one', async () => {
      const { owner, channel, members } = await squad();
      const [author, reader] = members;
      const sent = await sendMessage(t, author, channel.id, 'will be removed');
      const sync = () =>
        t
          .as(reader)
          .post('/api/chat/sync')
          .send({ cursors: { [channel.id]: 0 } });
      const warm = z.array(chatChannelSyncSchema).parse((await sync()).body);
      expect(warm[0].messages[0].body).toBe('will be removed');
      expect((await del(owner, channel.id, sent.body.message.id)).status).toBe(
        204,
      );
      const after = z.array(chatChannelSyncSchema).parse((await sync()).body);
      expect(after[0].messages[0]).toMatchObject({ deleted: true, body: null });
      expect(JSON.stringify(after)).not.toContain('will be removed');
    });

    it("S24 AS-53: a moderator deletes a member's message; not a moderator's, staff's or the owner's; a non-author member deletes nothing", async () => {
      const { w, owner, moderator, channel, members } = await squad();
      const [plain, other] = members;
      const staff = await addShopMember(t, w.shop.id, 'STAFF');
      await t.as(staff).post(`/api/chat/channels/${channel.id}/join`);
      const otherMod = await joinedBuyer(t, channel.id);
      await exec(
        t.app,
        `UPDATE "ChatChannelMember" SET role = 'MODERATOR' WHERE "channelId" = :id AND "userId" = :userId`,
        { id: channel.id, userId: otherMod.id },
      );
      const mine = await sendMessage(t, plain, channel.id, 'member message');
      const byMod = await sendMessage(
        t,
        otherMod,
        channel.id,
        'moderator message',
      );
      const byStaff = await sendMessage(t, staff, channel.id, 'staff message');
      const byOwner = await sendMessage(t, owner, channel.id, 'owner message');

      expect(
        (await del(other, channel.id, mine.body.message.id)).body.code,
      ).toBe('permission_denied');
      for (const m of [byMod, byStaff, byOwner]) {
        const res = await del(moderator, channel.id, m.body.message.id);
        expect([res.status, res.body.code]).toEqual([403, 'permission_denied']);
      }
      expect(
        (await del(moderator, channel.id, mine.body.message.id)).status,
      ).toBe(204);
      expect((await del(owner, channel.id, byMod.body.message.id)).status).toBe(
        204,
      );
    });

    it(`S24 AS-53: a repeat is 204 and emits nothing; twenty at once change one row and publish one event (${REPEATS} repeats)`, async () => {
      for (let i = 0; i < REPEATS; i++) {
        const { owner, channel, members } = await squad();
        const sent = await sendMessage(
          t,
          members[0],
          channel.id,
          `to delete ${i}`,
        );
        const id = sent.body.message.id as string;
        const results = await Promise.all(
          Array.from({ length: 6 }, (_, n) =>
            del(n % 2 ? owner : members[0], channel.id, id),
          ),
        );
        expect(results.map((r) => r.status)).toEqual(Array(6).fill(204));
        expect(
          await rows(
            t.app,
            `SELECT 1 FROM "ChatMessage" WHERE id = :id AND "deletedAt" IS NOT NULL`,
            { id },
          ),
        ).toHaveLength(1);
        expect(t.live.eventsOf(channel.id, 'message_deleted')).toHaveLength(1);
        expect((await del(members[0], channel.id, id)).status).toBe(204);
        expect(t.live.eventsOf(channel.id, 'message_deleted')).toHaveLength(1);
        const [{ deleteEpoch }] = await rows<{ deleteEpoch: string }>(
          t.app,
          `SELECT "deleteEpoch" FROM "ChatChannel" WHERE id = :id`,
          { id: channel.id },
        );
        expect(deleteEpoch).toBe('1');
        await clearRateLimits(t.app);
      }
    });

    it('S24 AS-53: an unknown message or one of another channel is 404 message_not_found, a stranger 404 channel_not_found', async () => {
      const a = await squad();
      const b = await squad();
      const foreign = await sendMessage(
        t,
        b.members[0],
        b.channel.id,
        'elsewhere',
      );
      for (const messageId of [newId(), foreign.body.message.id as string]) {
        const res = await del(a.owner, a.channel.id, messageId);
        expect([res.status, res.body.code]).toEqual([404, 'message_not_found']);
      }
      const stranger = await t.user();
      const own = await sendMessage(t, a.members[0], a.channel.id, 'mine');
      const hidden = await del(stranger, a.channel.id, own.body.message.id);
      expect([hidden.status, hidden.body.code]).toEqual([
        404,
        'channel_not_found',
      ]);
      expect(
        (
          await t
            .http()
            .delete(
              `/api/chat/channels/${a.channel.id}/messages/${own.body.message.id}`,
            )
        ).status,
      ).toBe(401);
      expect((await del(a.owner, a.channel.id, 'not-a-uuid')).status).toBe(400);
    });
  });

  describe('live authority (AS-54)', () => {
    it('S24 AS-54: a manager removed from the shop loses control at once but stays an ordinary member; a newly added manager acts without joining', async () => {
      const w = await seedWorld(t);
      const creator = await addShopMember(t, w.shop.id, 'STAFF');
      const channelRes = await t
        .as(creator)
        .post('/api/chat/channels')
        .send({ productId: w.product.id });
      expect(channelRes.status).toBe(201);
      const channel = channelRes.body as ChannelBody;
      const buyer = await joinedBuyer(t, channel.id);
      const second = await joinedBuyer(t, channel.id);

      expect(
        (await act(creator, channel.id, 'promote', { userId: buyer.id }))
          .status,
      ).toBe(204);
      expect(
        (
          await t
            .as(creator)
            .patch(`/api/chat/channels/${channel.id}`)
            .send({ title: 'Mine' })
        ).status,
      ).toBe(200);

      // the owner of the shop removes the creator: the tenancy writer drops its authority cache
      expect(
        (
          await t
            .as(w.owner)
            .delete(`/api/shops/${w.shop.id}/members/${creator.id}`)
        ).status,
      ).toBeLessThan(300);

      for (const call of [
        () =>
          t
            .as(creator)
            .patch(`/api/chat/channels/${channel.id}`)
            .send({ isArchived: true }),
        () => act(creator, channel.id, 'promote', { userId: second.id }),
        () => act(creator, channel.id, 'demote', { userId: buyer.id }),
        () => act(creator, channel.id, 'ban', { userId: buyer.id }),
      ]) {
        const res = await call();
        expect([res.status, res.body.code]).toEqual([403, 'permission_denied']);
      }
      expect(await member(channel.id, creator.id)).toMatchObject({
        role: 'OWNER',
        status: 'ACTIVE',
      });
      expect(
        (await sendMessage(t, creator, channel.id, 'still a member')).status,
      ).toBe(201);

      const added = await t.user();
      await addMember(t.app, w.shop.id, added.id, 'STAFF');
      expect(
        (
          await t
            .as(added)
            .patch(`/api/chat/channels/${channel.id}`)
            .send({ title: 'New manager' })
        ).status,
      ).toBe(200);
      expect(
        (await act(added, channel.id, 'ban', { userId: second.id })).status,
      ).toBe(204);
    });
  });

  describe('gateway ticket (AS-55)', () => {
    it('S24 AS-55: 201 with a signed ticket for the user, purpose ws, 60 seconds from the clock', async () => {
      const user = await t.user();
      const res = await t.as(user).post('/api/chat/ws-ticket');
      expect(res.status).toBe(201);
      const body = chatWsTicketSchema.parse(res.body);
      expect(body.expiresAt).toBe(new Date(T.getTime() + 60_000).toISOString());
      expect(body.wsUrl).toBe(t.app.get(ApiConfigService).get('chat_ws_url'));
      const claims = jwt.verify(
        body.ticket,
        t.app.get(ApiConfigService).get('jwt_secret'),
        {
          algorithms: ['HS256'],
          clockTimestamp: Math.floor(T.getTime() / 1000),
        },
      ) as jwt.JwtPayload;
      expect(claims).toMatchObject({
        sub: user.id,
        typ: 'ws',
        iat: T.getTime() / 1000,
        exp: T.getTime() / 1000 + 60,
      });
      // expired a second later
      expect(() =>
        jwt.verify(body.ticket, t.app.get(ApiConfigService).get('jwt_secret'), {
          algorithms: ['HS256'],
          clockTimestamp: T.getTime() / 1000 + 61,
        }),
      ).toThrow(/expired/);
    });

    it('S24 AS-55: no credentials is 401; the 31st ticket within a minute is 429; a ticket is not an API credential', async () => {
      const user = await t.user();
      expect((await t.http().post('/api/chat/ws-ticket')).status).toBe(401);
      const first = await t.as(user).post('/api/chat/ws-ticket');
      for (let i = 1; i < 30; i++)
        expect((await t.as(user).post('/api/chat/ws-ticket')).status).toBe(201);
      const limited = await t.as(user).post('/api/chat/ws-ticket');
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('rate_limited');
      const asBearer = await t
        .http()
        .get('/api/chat/unread')
        .set('Authorization', `Bearer ${first.body.ticket}`);
      expect(asBearer.status).toBe(401);
    });

    it('S24 AS-55: a user whose session was revoked gets no ticket', async () => {
      const user = await t.user();
      expect((await t.as(user).post('/api/auth/logout')).status).toBeLessThan(
        300,
      );
      const res = await t.as(user).post('/api/chat/ws-ticket');
      expect(res.status).toBe(401);
    });
  });
});
