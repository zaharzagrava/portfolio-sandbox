import {
  chatChannelSyncSchema,
  chatMessagePageSchema,
} from '@marketplace-sandbox/contracts';
import { z } from 'zod';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { InvalidScheduleError } from '@app/infrastructure/jobs/job-errors';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { recordStatements } from '@app/test/utils/catalog-fixtures';
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
const syncResponse = z.array(chatChannelSyncSchema);

describe('Product chat: sync on reconnect, history and partitions', () => {
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
  const sync = (user: TestUser, cursors: unknown) =>
    t
      .as(user)
      .post('/api/chat/sync')
      .send({ cursors } as object);
  /** `n` messages in one statement, numbered by the insert trigger exactly as the gateway's rows are. */
  const bulk = (channelId: string, authorId: string, n: number, from = 1) =>
    exec(
      t.app,
      `INSERT INTO "ChatMessage" (id, "channelId", "authorId", body, "replyToId", "createdAt")
       SELECT uuidv7(), :channelId, :authorId, 'm' || g, NULL, now() FROM generate_series(:from, :to) g`,
      { channelId, authorId, from, to: from + n - 1 },
    );
  /** What a moderator's delete does to the rows (the service does the same two writes in one transaction). */
  const softDelete = (channelId: string, seq: number) =>
    exec(
      t.app,
      `UPDATE "ChatMessage" SET "deletedAt" = now() WHERE "channelId" = :channelId AND seq = :seq;
       UPDATE "ChatChannel" SET "deleteEpoch" = "deleteEpoch" + 1 WHERE id = :channelId`,
      { channelId, seq },
    );
  const seqs = (body: z.infer<typeof syncResponse>[number] | undefined) =>
    body?.messages.map((m) => m.seq);

  describe('what was missed (AS-21, AS-22)', () => {
    it('S24 AS-21: a member gets the messages after their cursor, ascending; at or past the head nothing; from 0 everything', async () => {
      const { owner, buyer, channel } = await room();
      for (let i = 1; i <= 5; i++)
        await sendMessage(t, owner, channel.id, `m${i}`);
      const part = await sync(buyer, { [channel.id]: 3 });
      expect(part.status).toBe(200);
      const [entry] = syncResponse.parse(part.body);
      expect(entry).toMatchObject({
        channelId: channel.id,
        lastSeq: 5,
        hasMore: false,
      });
      expect(entry.messages.map((m) => [m.seq, m.body])).toEqual([
        [4, 'm4'],
        [5, 'm5'],
      ]);
      for (const cursor of [5, 6, 9_007_199_254_740_991]) {
        const [none] = syncResponse.parse(
          (await sync(buyer, { [channel.id]: cursor })).body,
        );
        expect(none).toMatchObject({
          messages: [],
          lastSeq: 5,
          hasMore: false,
        });
      }
      const [all] = syncResponse.parse(
        (await sync(buyer, { [channel.id]: 0 })).body,
      );
      expect(seqs(all)).toEqual([1, 2, 3, 4, 5]);
    });

    it('S24 AS-22: 450 messages come in pages of 200, each exactly once and in order', async () => {
      const { owner, buyer, channel } = await room();
      await bulk(channel.id, owner.id, 450);
      const pages = [] as Array<ReturnType<typeof seqs>>;
      let cursor = 0;
      const flags: boolean[] = [];
      for (let i = 0; i < 3; i++) {
        const [entry] = syncResponse.parse(
          (await sync(buyer, { [channel.id]: cursor })).body,
        );
        expect(entry.lastSeq).toBe(450);
        flags.push(entry.hasMore);
        pages.push(seqs(entry));
        cursor = entry.messages[entry.messages.length - 1].seq;
      }
      expect(flags).toEqual([true, true, false]);
      expect(pages.map((p) => [p![0], p![p!.length - 1], p!.length])).toEqual([
        [1, 200, 200],
        [201, 400, 200],
        [401, 450, 50],
      ]);
      expect(pages.flat()).toEqual(
        Array.from({ length: 450 }, (_, i) => i + 1),
      );
    });
  });

  describe('many channels (AS-23, AS-24, AS-25)', () => {
    it('S24 AS-23: 50 channels in one call are three statements cold and one warm; 51 is 400 too_many_channels; empty is []', async () => {
      const w = await seedWorld(t);
      const buyer = await t.user();
      const ids: string[] = [];
      for (let i = 0; i < 50; i++) {
        if (i % 20 === 0) await clearRateLimits(t.app);
        const product = await createProduct(t.app, w.shop, {});
        const created = await t
          .as(w.owner)
          .post('/api/chat/channels')
          .send({ productId: product.id });
        expect(created.status).toBe(201);
        expect(
          (await t.as(buyer).post(`/api/chat/channels/${created.body.id}/join`))
            .status,
        ).toBe(200);
        await bulk(created.body.id, w.owner.id, 1 + (i % 3));
        ids.push(created.body.id);
      }
      await clearRateLimits(t.app);
      const cursors = Object.fromEntries(ids.map((id) => [id, 0]));

      const cold = await recordStatements(
        t.app,
        () => sync(buyer, cursors),
        /"Chat/,
      );
      expect(cold.result.status).toBe(200);
      expect(cold.statements).toHaveLength(3);
      const body = syncResponse.parse(cold.result.body);
      expect(body.map((e) => e.channelId)).toEqual(ids);
      body.forEach((e, i) =>
        expect(seqs(e)).toEqual(
          Array.from({ length: 1 + (i % 3) }, (_, n) => n + 1),
        ),
      );

      const warm = await recordStatements(
        t.app,
        () => sync(buyer, cursors),
        /"Chat/,
      );
      expect(syncResponse.parse(warm.result.body)).toEqual(body);
      expect(warm.statements).toHaveLength(1);

      const tooMany = await recordStatements(
        t.app,
        () => sync(buyer, { ...cursors, [newId()]: 0 }),
        /"Chat/,
      );
      expect(tooMany.result.status).toBe(400);
      expect(tooMany.result.body.code).toBe('too_many_channels');
      expect(tooMany.statements).toHaveLength(0);

      const empty = await sync(buyer, {});
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual([]);
    });

    it('S24 AS-24: a channel the caller is not in, was banned from, or that does not exist is absent, byte for byte', async () => {
      const mine = await room();
      const other = await room();
      const banned = await room();
      await bulk(mine.channel.id, mine.owner.id, 2);
      await bulk(other.channel.id, other.owner.id, 2);
      await bulk(banned.channel.id, banned.owner.id, 2);
      await exec(
        t.app,
        `UPDATE "ChatChannelMember" SET status = 'BANNED' WHERE "channelId" = :id AND "userId" = :userId`,
        {
          id: banned.channel.id,
          userId: banned.buyer.id,
        },
      );
      await t
        .as(banned.buyer)
        .post(`/api/chat/channels/${mine.channel.id}/join`);
      const user = banned.buyer;
      const plain = await sync(user, { [mine.channel.id]: 0 });
      const noisy = await sync(user, {
        [other.channel.id]: 0,
        [banned.channel.id]: 0,
        [newId()]: 0,
        [mine.channel.id]: 0,
      });
      expect(plain.status).toBe(200);
      expect(noisy.status).toBe(200);
      expect(noisy.text).toBe(plain.text);
      expect(syncResponse.parse(noisy.body).map((e) => e.channelId)).toEqual([
        mine.channel.id,
      ]);
    });

    it.each<[string, unknown]>([
      ['a key that is not a UUID', { 'not-a-uuid': 1 }],
      ['a negative cursor', { [newId()]: -1 }],
      ['a fractional cursor', { [newId()]: 1.5 }],
      ['a cursor that is a string', { [newId()]: '3' }],
      ['a cursor above 2^53-1', { [newId()]: 2 ** 53 }],
      ['a null cursor', { [newId()]: null }],
    ])(
      'S24 AS-25: %s is 400 validation_failed and nothing is processed',
      async (_label, cursors) => {
        const { buyer } = await room();
        const processed = await recordStatements(
          t.app,
          () => sync(buyer, cursors),
          /"Chat/,
        );
        expect(processed.result.status).toBe(400);
        expect(processed.result.body.code).toBe('validation_failed');
        expect(processed.statements).toHaveLength(0);
      },
    );

    it('S24 AS-25: cursors missing or not an object is 400, one invalid entry among valid ones refuses all, no credentials is 401', async () => {
      const { buyer, channel } = await room();
      for (const body of [
        {},
        { cursors: null },
        { cursors: [] },
        { cursors: 'x' },
        { cursors: { [channel.id]: 0, bad: 1 } },
      ]) {
        const res = await t.as(buyer).post('/api/chat/sync').send(body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
      }
      expect(
        (await t.http().post('/api/chat/sync').send({ cursors: {} })).status,
      ).toBe(401);
    });
  });

  describe('deleted messages (AS-26)', () => {
    it('S24 AS-26: a deleted message is a tombstone that keeps its sequence', async () => {
      const { owner, buyer, channel } = await room();
      for (let i = 1; i <= 3; i++)
        await sendMessage(t, owner, channel.id, `secret ${i}`);
      await softDelete(channel.id, 2);
      const [entry] = syncResponse.parse(
        (await sync(buyer, { [channel.id]: 0 })).body,
      );
      expect(entry.messages.map((m) => [m.seq, m.deleted, m.body])).toEqual([
        [1, false, 'secret 1'],
        [2, true, null],
        [3, false, 'secret 3'],
      ]);
    });

    it('S24 AS-26: a delete after a warm sync is visible in the very next response (no stale body)', async () => {
      const { owner, buyer, channel } = await room();
      for (let i = 1; i <= 3; i++)
        await sendMessage(t, owner, channel.id, `secret ${i}`);
      const warm = syncResponse.parse(
        (await sync(buyer, { [channel.id]: 0 })).body,
      );
      expect(warm[0].messages.every((m) => !m.deleted)).toBe(true);
      await softDelete(channel.id, 3);
      const after = syncResponse.parse(
        (await sync(buyer, { [channel.id]: 1 })).body,
      );
      expect(after[0].messages.map((m) => [m.seq, m.deleted, m.body])).toEqual([
        [2, false, 'secret 2'],
        [3, true, null],
      ]);
      expect(JSON.stringify(after)).not.toContain('secret 3');
    });
  });

  describe('history (AS-27)', () => {
    const history = (user: TestUser, channelId: string, query = '') =>
      t.as(user).get(`/api/chat/channels/${channelId}/messages${query}`);

    it('S24 AS-27: pages of 50 newest first, tombstones included, each message once, the default limit is 50', async () => {
      const { owner, buyer, channel } = await room();
      await bulk(channel.id, owner.id, 120);
      await softDelete(channel.id, 100);
      const first = await history(buyer, channel.id, '?limit=50');
      expect(first.status).toBe(200);
      const page1 = chatMessagePageSchema.parse(first.body);
      expect(page1.items.map((m) => m.seq)).toEqual(
        Array.from({ length: 50 }, (_, i) => 120 - i),
      );
      expect(page1.items.find((m) => m.seq === 100)).toMatchObject({
        deleted: true,
        body: null,
      });
      expect(page1.nextCursor).not.toBeNull();
      const page2 = chatMessagePageSchema.parse(
        (
          await history(
            buyer,
            channel.id,
            `?limit=50&cursor=${page1.nextCursor}`,
          )
        ).body,
      );
      expect(page2.items.map((m) => m.seq)).toEqual(
        Array.from({ length: 50 }, (_, i) => 70 - i),
      );
      const page3 = chatMessagePageSchema.parse(
        (
          await history(
            buyer,
            channel.id,
            `?limit=50&cursor=${page2.nextCursor}`,
          )
        ).body,
      );
      expect(page3.items.map((m) => m.seq)).toEqual(
        Array.from({ length: 20 }, (_, i) => 20 - i),
      );
      expect(page3.nextCursor).toBeNull();
      const dflt = chatMessagePageSchema.parse(
        (await history(buyer, channel.id)).body,
      );
      expect(dflt.items).toHaveLength(50);
    });

    it.each([
      '?limit=0',
      '?limit=101',
      '?limit=abc',
      '?limit=1.5',
      '?cursor=not-a-cursor',
      `?cursor=${Buffer.from('{"seq":"x"}').toString('base64url')}`,
    ])('S24 AS-27: %s is 400 validation_failed', async (query) => {
      const { buyer, channel } = await room();
      const res = await history(buyer, channel.id, query);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
    });

    it('S24 AS-27: a stranger is 404 channel_not_found, a banned member 403 banned, no credentials 401', async () => {
      const { buyer, channel } = await room();
      const stranger = await t.user();
      const denied = await history(stranger, channel.id);
      expect(denied.status).toBe(404);
      expect(denied.body.code).toBe('channel_not_found');
      await exec(
        t.app,
        `UPDATE "ChatChannelMember" SET status = 'BANNED' WHERE "channelId" = :id AND "userId" = :userId`,
        {
          id: channel.id,
          userId: buyer.id,
        },
      );
      const banned = await history(buyer, channel.id);
      expect(banned.status).toBe(403);
      expect(banned.body.code).toBe('banned');
      expect(
        (await t.http().get(`/api/chat/channels/${channel.id}/messages`))
          .status,
      ).toBe(401);
    });
  });

  describe('partitions (AS-28, AS-29)', () => {
    it('S24 AS-28: across three months sync and history return everything in order; a replay across midnight is the same message; the sequence never restarts', async () => {
      await t.jobs.partitionMaintenance();
      const { owner, buyer, channel } = await room();
      await t.setTime(new Date('2026-10-31T23:59:59.000Z'));
      const clientMessageId = newId();
      const last = await sendMessage(t, owner, channel.id, 'last of October', {
        clientMessageId,
      });
      expect(last.status).toBe(201);

      await t.setTime(new Date('2026-11-01T00:00:01.000Z'));
      const replay = await sendMessage(
        t,
        owner,
        channel.id,
        'last of October',
        { clientMessageId },
      );
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({
        message: last.body.message,
        duplicate: true,
      });
      const first = await sendMessage(
        t,
        owner,
        channel.id,
        'first of November',
      );
      expect(first.body.message.seq).toBe(2);

      await t.setTime(new Date('2026-12-15T10:00:00.000Z'));
      const december = await sendMessage(t, owner, channel.id, 'december');
      expect(december.body.message.seq).toBe(3);

      const stored = await rows<{ part: string }>(
        t.app,
        `SELECT tableoid::regclass::text AS part FROM "ChatMessage" WHERE "channelId" = :id ORDER BY seq`,
        { id: channel.id },
      );
      expect(stored).toHaveLength(3);
      expect(new Set(stored.map((r) => r.part)).size).toBe(3);

      const [entry] = syncResponse.parse(
        (await sync(buyer, { [channel.id]: 0 })).body,
      );
      expect(seqs(entry)).toEqual([1, 2, 3]);
      const page = chatMessagePageSchema.parse(
        (
          await t
            .as(buyer)
            .get(`/api/chat/channels/${channel.id}/messages?limit=2`)
        ).body,
      );
      expect(page.items.map((m) => m.seq)).toEqual([3, 2]);
      const rest = chatMessagePageSchema.parse(
        (
          await t
            .as(buyer)
            .get(
              `/api/chat/channels/${channel.id}/messages?limit=2&cursor=${page.nextCursor}`,
            )
        ).body,
      );
      expect(rest.items.map((m) => m.seq)).toEqual([1]);
    });

    it('S24 AS-29: the job creates the current month and the next three, is idempotent and safe to overlap, and moves rows parked for a missing month', async () => {
      const far = new Date('2031-03-10T09:00:00.000Z');
      const partitionsOf2031 = async () =>
        (
          await rows<{ relname: string }>(
            t.app,
            `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
            WHERE i.inhparent = '"ChatMessage"'::regclass AND c.relname LIKE 'ChatMessage_2031_%' ORDER BY c.relname`,
          )
        ).map((r) => r.relname);
      const missing = () =>
        MetricsRegistry.value('chat_history_partition_missing_total') ?? 0;
      try {
        const { owner, channel } = await room();
        await t.setTime(far);
        expect(await partitionsOf2031()).toEqual([]);

        // maintenance has not run for this month: the message is still stored, in the default partition, and counted
        const before = missing();
        const parked = await sendMessage(
          t,
          owner,
          channel.id,
          'no partition yet',
        );
        expect(parked.status).toBe(201);
        expect(missing()).toBe(before + 1);
        const [where] = await rows<{ part: string }>(
          t.app,
          `SELECT tableoid::regclass::text AS part FROM "ChatMessage" WHERE id = :id`,
          { id: parked.body.message.id },
        );
        expect(where.part).toContain('ChatMessage_default');

        await t.jobs.partitionMaintenance();
        expect(await partitionsOf2031()).toEqual([
          'ChatMessage_2031_03',
          'ChatMessage_2031_04',
          'ChatMessage_2031_05',
          'ChatMessage_2031_06',
        ]);
        const [moved] = await rows<{ part: string }>(
          t.app,
          `SELECT tableoid::regclass::text AS part FROM "ChatMessage" WHERE id = :id`,
          { id: parked.body.message.id },
        );
        expect(moved.part).toContain('ChatMessage_2031_03');
        const [defaults] = await rows<{ n: string }>(
          t.app,
          `SELECT count(*)::text AS n FROM "ChatMessage_default"`,
        );
        expect(defaults.n).toBe('0');

        // again, and two at once: nothing changes, nothing fails
        await t.jobs.partitionMaintenance();
        await Promise.all([
          t.jobs.partitionMaintenance(),
          t.jobs.partitionMaintenance(),
        ]);
        expect(await partitionsOf2031()).toHaveLength(4);

        // and the message is still where history reads it
        const [entry] = syncResponse.parse(
          (await sync(owner, { [channel.id]: 0 })).body,
        );
        expect(entry.messages.map((m) => m.id)).toEqual([
          parked.body.message.id,
        ]);
      } finally {
        await exec(
          t.app,
          `DELETE FROM "ChatMessageIndex" WHERE "createdAt" >= '2031-01-01'`,
        );
        await exec(
          t.app,
          `DELETE FROM "ChatMessage" WHERE "createdAt" >= '2031-01-01'`,
        );
        for (const name of await partitionsOf2031())
          await exec(t.app, `DROP TABLE "${name}"`);
      }
    });

    it('S24 AS-29: a schedule with a payload the job does not take is refused with InvalidScheduleError', async () => {
      await expect(
        t.app.get(JobsService).upsertSchedule({
          name: 'chat.partition-maintenance-bad',
          cron: '0 27 3 * * *',
          jobType: 'chat.partition-maintenance',
          payload: { surprise: true } as never,
          overlap: 'skip',
        }),
      ).rejects.toBeInstanceOf(InvalidScheduleError);
    });
  });
});
