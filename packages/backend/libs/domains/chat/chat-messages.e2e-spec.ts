import { createHash } from 'node:crypto';
import { sendMessageResponseSchema } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { chatLimiterUnavailable } from './domain/chat-metrics';
import {
  clearRateLimits,
  createChatApp,
  exec,
  fastStoreOf,
  gatewayInsert,
  joinedBuyer,
  newId,
  openChannel,
  rows,
  seedWorld,
  sendMessage,
  type ChatTestApp,
  type FastStore,
  type TestUser,
} from './testing/chat-app';

const T = new Date('2026-10-14T12:00:00.000Z');
const REPEATS = 20;

/** The deterministic event id of `chat.message_posted` (research R-03): the message id's time prefix, version 7, md5 tail. */
const eventIdFor = (messageId: string): string => {
  const hex = messageId.replace(/-/g, '');
  const md5 = createHash('md5').update(`chat-msg:${messageId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${md5.slice(0, 3)}-8${md5.slice(3, 6)}-${md5.slice(6, 18)}`;
};

describe('Product chat: idempotent send, per-channel sequence and events', () => {
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

  /** A channel with its owner and one joined buyer, each with their own shop and product (L-005, L-006). */
  const room = async () => {
    const w = await seedWorld(t);
    const channel = await openChannel(t, w);
    const buyer = await joinedBuyer(t, channel.id);
    return { w, owner: w.owner, buyer, channel };
  };
  const stored = (channelId: string) =>
    rows<{
      id: string;
      seq: string;
      authorId: string;
      body: string;
      clientMessageId: string | null;
      replyToId: string | null;
    }>(
      t.app,
      `SELECT id, seq, "authorId", body, "clientMessageId", "replyToId" FROM "ChatMessage" WHERE "channelId" = :channelId ORDER BY seq`,
      { channelId },
    );
  const lastSeq = async (channelId: string) =>
    Number(
      (
        await rows<{ lastSeq: string }>(
          t.app,
          `SELECT "lastSeq" FROM "ChatChannel" WHERE id = :channelId`,
          { channelId },
        )
      )[0].lastSeq,
    );
  const events = (channelId: string) =>
    rows<{
      id: string;
      payload: {
        eventId: string;
        aggregateId: string;
        aggregateVersion: number;
        version: number;
        type: string;
        payload: Record<string, unknown>;
      };
    }>(
      t.app,
      `SELECT id, payload FROM "Outbox" WHERE "aggregateId" = :channelId AND "type" = 'chat.message_posted' ORDER BY "createdAt", id`,
      { channelId },
    );
  const seedHistory = async (
    channelId: string,
    author: TestUser,
    n: number,
  ) => {
    for (let i = 0; i < n; i++)
      expect(
        (await sendMessage(t, author, channelId, `history ${i + 1}`)).status,
      ).toBe(201);
    await clearRateLimits(t.app);
  };

  describe('send and replay (AS-09 to AS-12)', () => {
    it('S24 AS-09: the next sequence number, one row, one event, one live publish', async () => {
      const { owner, buyer, channel } = await room();
      await seedHistory(channel.id, owner, 4);
      const clientMessageId = newId();
      const res = await sendMessage(t, buyer, channel.id, 'Is it unlocked?', {
        clientMessageId,
      });
      expect(res.status).toBe(201);
      const body = sendMessageResponseSchema.parse(res.body);
      expect(body.duplicate).toBe(false);
      expect(body.message).toMatchObject({
        seq: 5,
        authorId: buyer.id,
        body: 'Is it unlocked?',
        replyToId: null,
        deleted: false,
        createdAt: T.toISOString(),
      });
      expect(
        (await stored(channel.id)).filter(
          (m) => m.clientMessageId === clientMessageId,
        ),
      ).toHaveLength(1);
      expect(await lastSeq(channel.id)).toBe(5);
      expect(
        (await events(channel.id)).filter(
          (e) => e.payload.payload.messageId === body.message.id,
        ),
      ).toHaveLength(1);
      const pushed = t.live
        .eventsOf(channel.id, 'message')
        .filter((e) => (e.message as { id: string }).id === body.message.id);
      expect(pushed).toHaveLength(1);
      expect(pushed[0]).toMatchObject({
        type: 'message',
        channelId: channel.id,
        seq: 5,
      });
    });

    it('S24 AS-10: the identical request again is 200 with the same message and nothing new (20 sequential replays)', async () => {
      const { buyer, channel } = await room();
      const clientMessageId = newId();
      const first = await sendMessage(t, buyer, channel.id, 'Is it unlocked?', {
        clientMessageId,
      });
      expect(first.status).toBe(201);
      for (let i = 0; i < 20; i++) {
        if (i % 8 === 7) await clearRateLimits(t.app);
        const again = await sendMessage(
          t,
          buyer,
          channel.id,
          'Is it unlocked?',
          { clientMessageId },
        );
        expect(again.status).toBe(200);
        expect(again.body).toEqual({
          message: first.body.message,
          duplicate: true,
        });
      }
      expect(await stored(channel.id)).toHaveLength(1);
      expect(await lastSeq(channel.id)).toBe(1);
      expect(await events(channel.id)).toHaveLength(1);
      expect(t.live.eventsOf(channel.id, 'message')).toHaveLength(1);
    });

    it('S24 AS-11: the same key with another body or another reply target is 422 idempotency_key_reuse and the message is unchanged', async () => {
      const { owner, buyer, channel } = await room();
      const target = (await sendMessage(t, owner, channel.id, 'a target')).body
        .message.id as string;
      const clientMessageId = newId();
      const first = await sendMessage(t, buyer, channel.id, 'original', {
        clientMessageId,
      });
      expect(first.status).toBe(201);
      const changedBody = await sendMessage(t, buyer, channel.id, 'changed', {
        clientMessageId,
      });
      expect(changedBody.status).toBe(422);
      expect(changedBody.body.code).toBe('idempotency_key_reuse');
      const changedReply = await sendMessage(t, buyer, channel.id, 'original', {
        clientMessageId,
        replyToId: target,
      });
      expect(changedReply.status).toBe(422);
      expect(changedReply.body.code).toBe('idempotency_key_reuse');
      const rowsNow = await stored(channel.id);
      expect(rowsNow).toHaveLength(2);
      expect(rowsNow[1]).toMatchObject({
        id: first.body.message.id,
        body: 'original',
        replyToId: null,
      });
    });

    it('S24 AS-12: the key is scoped to (channel, author): another author and another channel get their own message and learn nothing', async () => {
      const { owner, buyer, channel } = await room();
      await seedHistory(channel.id, owner, 4);
      const clientMessageId = newId();
      const mine = await sendMessage(t, buyer, channel.id, 'from the buyer', {
        clientMessageId,
      });
      expect(mine.status).toBe(201);
      expect(mine.body.message.seq).toBe(5);

      const theirs = await sendMessage(t, owner, channel.id, 'from the owner', {
        clientMessageId,
      });
      expect(theirs.status).toBe(201);
      expect(theirs.body.message).toMatchObject({
        seq: 6,
        authorId: owner.id,
        body: 'from the owner',
      });
      expect(JSON.stringify(theirs.body)).not.toContain(mine.body.message.id);
      expect(
        (await stored(channel.id)).find((m) => m.id === mine.body.message.id),
      ).toMatchObject({ body: 'from the buyer', seq: '5' });

      const w2 = await seedWorld(t);
      const other = await openChannel(t, w2);
      await t.as(buyer).post(`/api/chat/channels/${other.id}/join`);
      const elsewhere = await sendMessage(
        t,
        buyer,
        other.id,
        'same key, other channel',
        { clientMessageId },
      );
      expect(elsewhere.status).toBe(201);
      expect(elsewhere.body.message.id).not.toBe(mine.body.message.id);
      expect(elsewhere.body.message.seq).toBe(1);
    });
  });

  describe('concurrency (AS-13, AS-14)', () => {
    it(`S24 AS-13: ten identical sends at once store one message; one 201 and nine 200, same id and seq (${REPEATS} repeats)`, async () => {
      for (let i = 0; i < REPEATS; i++) {
        const { buyer, channel } = await room();
        const clientMessageId = newId();
        const results = await Promise.all(
          Array.from({ length: 10 }, () =>
            sendMessage(t, buyer, channel.id, 'once', { clientMessageId }),
          ),
        );
        expect(results.filter((r) => r.status === 201)).toHaveLength(1);
        expect(results.filter((r) => r.status === 200)).toHaveLength(9);
        expect(results.filter((r) => r.body.duplicate === false)).toHaveLength(
          1,
        );
        expect(new Set(results.map((r) => r.body.message.id)).size).toBe(1);
        expect(new Set(results.map((r) => r.body.message.seq))).toEqual(
          new Set([1]),
        );
        expect(await stored(channel.id)).toHaveLength(1);
        expect(await events(channel.id)).toHaveLength(1);
        await clearRateLimits(t.app);
      }
    });

    it(`S24 AS-14: 20 sends through the API and the gateway's insert at once number 1..20 without a gap (${REPEATS} repeats)`, async () => {
      for (let i = 0; i < REPEATS; i++) {
        const { owner, buyer, channel } = await room();
        await Promise.all([
          ...Array.from({ length: 5 }, (_, n) =>
            sendMessage(t, owner, channel.id, `owner ${n}`),
          ),
          ...Array.from({ length: 5 }, (_, n) =>
            sendMessage(t, buyer, channel.id, `buyer ${n}`),
          ),
          ...Array.from({ length: 5 }, (_, n) =>
            gatewayInsert(t.app, channel.id, owner.id, `gateway owner ${n}`),
          ),
          ...Array.from({ length: 5 }, (_, n) =>
            gatewayInsert(t.app, channel.id, buyer.id, `gateway buyer ${n}`),
          ),
        ]);
        const seqs = (await stored(channel.id)).map((m) => Number(m.seq));
        expect(seqs).toEqual(Array.from({ length: 20 }, (_, n) => n + 1));
        expect(await lastSeq(channel.id)).toBe(20);
        expect(await events(channel.id)).toHaveLength(20);
        await clearRateLimits(t.app);
      }
    });
  });

  describe('reply targets and validation (AS-15, AS-16)', () => {
    it('S24 AS-15: a reply target outside the channel is 422 reply_target_invalid, stores nothing and leaves no gap', async () => {
      const { owner, buyer, channel } = await room();
      await seedHistory(channel.id, owner, 3);
      const w2 = await seedWorld(t);
      const other = await openChannel(t, w2);
      const foreign = (await sendMessage(t, w2.owner, other.id, 'elsewhere'))
        .body.message.id as string;

      for (const replyToId of [newId(), foreign]) {
        const res = await sendMessage(t, buyer, channel.id, 'a reply', {
          replyToId,
        });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('reply_target_invalid');
      }
      expect(await stored(channel.id)).toHaveLength(3);
      expect(await lastSeq(channel.id)).toBe(3);
      const next = await sendMessage(t, buyer, channel.id, 'valid');
      expect(next.body.message.seq).toBe(4);
      expect(await events(channel.id)).toHaveLength(4);
    });

    it('S24 AS-15: a deleted message of the channel is a valid reply target', async () => {
      const { owner, buyer, channel } = await room();
      const target = (await sendMessage(t, owner, channel.id, 'to be deleted'))
        .body.message.id as string;
      await exec(
        t.app,
        `UPDATE "ChatMessage" SET "deletedAt" = now() WHERE id = :target`,
        { target },
      );
      const res = await sendMessage(
        t,
        buyer,
        channel.id,
        'replying to a tombstone',
        { replyToId: target },
      );
      expect(res.status).toBe(201);
      expect(res.body.message.replyToId).toBe(target);
    });

    it.each<[string, (id: string) => object]>([
      ['body missing', (clientMessageId) => ({ clientMessageId })],
      [
        'body not a string',
        (clientMessageId) => ({ clientMessageId, body: 42 }),
      ],
      ['body empty', (clientMessageId) => ({ clientMessageId, body: '' })],
      [
        'body whitespace only',
        (clientMessageId) => ({ clientMessageId, body: ' \n\t ' }),
      ],
      [
        'body of 4,001 characters',
        (clientMessageId) => ({ clientMessageId, body: 'x'.repeat(4001) }),
      ],
      [
        'body of 4,001 code points',
        (clientMessageId) => ({ clientMessageId, body: '😀'.repeat(4001) }),
      ],
      ['clientMessageId missing', () => ({ body: 'hi' })],
      [
        'clientMessageId not a UUID',
        () => ({ clientMessageId: 'abc', body: 'hi' }),
      ],
      [
        'replyToId not a UUID',
        (clientMessageId) => ({
          clientMessageId,
          body: 'hi',
          replyToId: 'abc',
        }),
      ],
      [
        'an unknown field',
        (clientMessageId) => ({ clientMessageId, body: 'hi', extra: true }),
      ],
    ])(
      'S24 AS-16: %s is 400 validation_failed and nothing is stored',
      async (_label, payload) => {
        const { buyer, channel } = await room();
        const res = await t
          .as(buyer)
          .post(`/api/chat/channels/${channel.id}/messages`)
          .send(payload(newId()));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
        expect(await stored(channel.id)).toHaveLength(0);
        expect(await lastSeq(channel.id)).toBe(0);
      },
    );

    it('S24 AS-16: a body of exactly 4,000 characters is stored, whitespace around it is trimmed', async () => {
      const { buyer, channel } = await room();
      const max = await sendMessage(
        t,
        buyer,
        channel.id,
        `  ${'😀'.repeat(4000)}  `,
      );
      expect(max.status).toBe(201);
      expect([...(max.body.message.body as string)]).toHaveLength(4000);
      const padded = await sendMessage(t, buyer, channel.id, '   hello   ');
      expect(padded.body.message.body).toBe('hello');
      expect((await stored(channel.id))[1].body).toBe('hello');
    });
  });

  describe('who may send (AS-17)', () => {
    it('S24 AS-17: no credentials 401; a stranger 404 channel_not_found; a malformed channel 400', async () => {
      const { channel } = await room();
      const stranger = await t.user();
      const anonymous = await t
        .http()
        .post(`/api/chat/channels/${channel.id}/messages`)
        .send({ clientMessageId: newId(), body: 'hi' });
      expect(anonymous.status).toBe(401);
      const denied = await sendMessage(t, stranger, channel.id, 'hi');
      expect(denied.status).toBe(404);
      expect(denied.body.code).toBe('channel_not_found');
      const unknown = await sendMessage(t, stranger, newId(), 'hi');
      expect(unknown.status).toBe(404);
      const bad = await sendMessage(t, stranger, 'not-a-uuid', 'hi');
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('validation_failed');
      expect(await stored(channel.id)).toHaveLength(0);
    });

    it('S24 AS-17: a banned member is 403 banned', async () => {
      const { buyer, channel } = await room();
      await exec(
        t.app,
        `UPDATE "ChatChannelMember" SET status = 'BANNED' WHERE "channelId" = :id AND "userId" = :userId`,
        { id: channel.id, userId: buyer.id },
      );
      const res = await sendMessage(t, buyer, channel.id, 'hi');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('banned');
      expect(await stored(channel.id)).toHaveLength(0);
    });

    it('S24 AS-17: a muted member is 403 muted with mutedUntil until the frozen clock passes it, then 201', async () => {
      const { buyer, channel } = await room();
      const until = new Date(T.getTime() + 10 * 60_000);
      await exec(
        t.app,
        `UPDATE "ChatChannelMember" SET "mutedUntil" = :until WHERE "channelId" = :id AND "userId" = :userId`,
        { id: channel.id, userId: buyer.id, until },
      );
      const muted = await sendMessage(t, buyer, channel.id, 'hi');
      expect(muted.status).toBe(403);
      expect(muted.body).toMatchObject({
        code: 'muted',
        mutedUntil: until.toISOString(),
      });
      expect(await stored(channel.id)).toHaveLength(0);
      await t.setTime(new Date(until.getTime() + 1000));
      const after = await sendMessage(t, buyer, channel.id, 'hi again');
      expect(after.status).toBe(201);
    });

    it('S24 AS-17: an archived channel is 409 channel_archived', async () => {
      const { buyer, channel } = await room();
      await exec(
        t.app,
        `UPDATE "ChatChannel" SET "isArchived" = true, "archivedAt" = now() WHERE id = :id`,
        { id: channel.id },
      );
      const res = await sendMessage(t, buyer, channel.id, 'hi');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('channel_archived');
      expect(await stored(channel.id)).toHaveLength(0);
    });
  });

  describe('limits and faults (AS-18, AS-19)', () => {
    it('S24 AS-18: the 11th send within 10 seconds is 429 rate_limited with Retry-After; other members are unaffected', async () => {
      const { owner, buyer, channel } = await room();
      for (let i = 0; i < 10; i++)
        expect((await sendMessage(t, buyer, channel.id, `m${i}`)).status).toBe(
          201,
        );
      const limited = await sendMessage(t, buyer, channel.id, 'one too many');
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('rate_limited');
      expect(limited.headers['retry-after']).toBeDefined();
      expect(await stored(channel.id)).toHaveLength(10);
      expect(
        (await sendMessage(t, owner, channel.id, 'unaffected')).status,
      ).toBe(201);
    });

    it('S24 AS-18: with the limiter store down sends are accepted (fail open) and the outage is counted', async () => {
      const { buyer, channel } = await room();
      const before = chatLimiterUnavailable();
      await fast.deny('rl:');
      try {
        const res = await sendMessage(t, buyer, channel.id, 'limiter is down');
        expect(res.status).toBe(201);
      } finally {
        await fast.allow();
      }
      expect(chatLimiterUnavailable()).toBe(before + 1);
    });

    it('S24 AS-19: with the live bus down the send is 201, stored, counted as a failed push, and a retry replays', async () => {
      const { buyer, channel } = await room();
      const failed = () =>
        MetricsRegistry.value('chat_push_failed_total', { kind: 'message' }) ??
        0;
      const before = failed();
      t.live.down = true;
      const clientMessageId = newId();
      const res = await sendMessage(t, buyer, channel.id, 'bus is down', {
        clientMessageId,
      });
      expect(res.status).toBe(201);
      expect(failed()).toBe(before + 1);
      expect(await stored(channel.id)).toHaveLength(1);
      const retry = await sendMessage(t, buyer, channel.id, 'bus is down', {
        clientMessageId,
      });
      expect(retry.status).toBe(200);
      expect(retry.body.duplicate).toBe(true);
    });
  });

  describe('events (AS-20)', () => {
    it('S24 AS-20: one chat.message_posted v1 per message, in sequence order, with a preview of 120 characters and an identity derived from the message', async () => {
      const { owner, channel } = await room();
      const long = 'abcdefghij'.repeat(20);
      const ids: string[] = [];
      for (let i = 0; i < 9; i++) {
        const res = await sendMessage(
          t,
          owner,
          channel.id,
          i === 0 ? long : `message ${i}`,
        );
        ids.push(res.body.message.id as string);
      }
      await clearRateLimits(t.app);
      for (let i = 9; i < 20; i++) {
        const res = await sendMessage(t, owner, channel.id, `message ${i}`);
        ids.push(res.body.message.id as string);
        if (i === 14) await clearRateLimits(t.app);
      }
      const written = await events(channel.id);
      expect(written).toHaveLength(20);
      expect(written.map((e) => e.payload.aggregateVersion)).toEqual(
        Array.from({ length: 20 }, (_, i) => i + 1),
      );
      written.forEach((e, i) => {
        expect(e.payload).toMatchObject({
          type: 'chat.message_posted',
          version: 1,
          aggregateId: channel.id,
        });
        expect(e.payload.payload).toEqual({
          channelId: channel.id,
          messageId: ids[i],
          seq: i + 1,
          authorId: owner.id,
          preview: i === 0 ? long.slice(0, 120) : `message ${i}`,
        });
        expect(e.id).toBe(eventIdFor(ids[i]));
        expect(e.payload.eventId).toBe(e.id);
      });
      expect((written[0].payload.payload.preview as string).length).toBe(120);
    });

    it('S24 AS-20: a message written by the gateway has its event too, with the same identity rule', async () => {
      const { owner, channel } = await room();
      await gatewayInsert(t.app, channel.id, owner.id, 'from the gateway');
      const [message] = await stored(channel.id);
      const [event] = await events(channel.id);
      expect(event.id).toBe(eventIdFor(message.id));
      expect(event.payload.aggregateVersion).toBe(1);
    });
  });
});
