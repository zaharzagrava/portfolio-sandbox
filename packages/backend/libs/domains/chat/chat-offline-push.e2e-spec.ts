import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  chatConsumedSchemas,
  chatOfflineNotifyBodySchema,
} from '@marketplace-sandbox/contracts';
import type { z } from 'zod';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { PermanentError } from '@app/infrastructure/projections/errors';
import { ChatOfflineCheckService } from './application/chat-offline-check.service';
import { CHAT_OFFLINE_QUEUE } from './application/chat-offline-check.service';
import { ChatOfflineScheduler } from './infra/chat-offline.scheduler';
import {
  clearRateLimits,
  createChatApp,
  exec,
  fastStoreOf,
  joinedBuyer,
  openChannel,
  rows,
  seedWorld,
  sendMessage,
  type ChatTestApp,
  type FastStore,
  type TestUser,
} from './testing/chat-app';

type CheckBody = z.infer<typeof chatOfflineNotifyBodySchema>;

const T = new Date('2026-10-14T10:00:00.000Z');
const SEC = 1000;

describe('Product chat: offline push scheduling, checks and escalation', () => {
  let t: ChatTestApp;
  let fast: FastStore;
  let scheduler: ChatOfflineScheduler;
  let check: ChatOfflineCheckService;

  beforeAll(async () => {
    t = await createChatApp();
    fast = fastStoreOf(t.app);
    scheduler = t.app.get(ChatOfflineScheduler);
    check = t.app.get(ChatOfflineCheckService);
  });
  afterAll(async () => {
    await fast.allow();
    await t.close();
  });
  beforeEach(async () => {
    await fast.allow();
    await t.reset();
    t.queue.sent.length = 0;
    t.queue.deadLettered.length = 0;
    await clearRateLimits(t.app);
    await t.setTime(T);
  });

  /** An owner with a channel and `n` joined buyers. */
  const room = async (n = 1) => {
    const w = await seedWorld(t);
    const channel = await openChannel(t, w);
    const buyers: TestUser[] = [];
    for (let i = 0; i < n; i++) buyers.push(await joinedBuyer(t, channel.id));
    return { w, owner: w.owner, buyers, buyer: buyers[0], channel };
  };
  const postedEnvelope = async (messageId: string): Promise<EventEnvelope> => {
    const [row] = await rows<{ payload: EventEnvelope }>(
      t.app,
      `SELECT payload FROM "Outbox" WHERE "type" = 'chat.message_posted' AND payload->'payload'->>'messageId' = :messageId`,
      { messageId },
    );
    return row.payload;
  };
  /** Sends a message through the API and returns the relay's envelope of `chat.message_posted` for it. */
  const send = async (
    author: TestUser,
    channelId: string,
    body = 'Is it still available?',
  ) => {
    const res = await sendMessage(t, author, channelId, body);
    expect(res.status).toBe(201);
    return {
      message: res.body.message as { id: string; seq: number },
      envelope: await postedEnvelope(res.body.message.id),
    };
  };
  const scheduled = () =>
    t.queue.sent.filter((m) => m.queue === CHAT_OFFLINE_QUEUE);
  const bodies = () => scheduled().map((m) => m.body as CheckBody);
  const escalations = (recipientId?: string) =>
    rows<{ payload: EventEnvelope & { aggregateId: string } }>(
      t.app,
      `SELECT payload FROM "Outbox" WHERE "type" = 'chat.message_escalated' ${recipientId ? `AND "aggregateId" = :recipientId` : ''} ORDER BY "createdAt", id`,
      { recipientId },
    );
  /** The check of one recipient for one message, as the scheduler would have queued it. */
  const bodyFor = (envelope: EventEnvelope, recipientId: string): CheckBody => {
    const p = envelope.payload as {
      channelId: string;
      messageId: string;
      seq: number;
      authorId: string;
      preview: string;
    };
    return { eventId: envelope.eventId, ...p, recipientId };
  };
  const at = (ms: number) => t.setTime(new Date(T.getTime() + ms));
  const counter = (name: string, labels?: Record<string, string>) =>
    MetricsRegistry.value(name, labels) ?? 0;

  describe('scheduling (AS-42)', () => {
    it('S24 AS-42: one delayed check per active member except the author, 30 seconds out, each with an identity from (eventId, recipientId)', async () => {
      const { owner, buyers, channel } = await room(2);
      const { envelope } = await send(owner, channel.id);
      await scheduler.project([envelope]);
      const queued = scheduled();
      expect(queued).toHaveLength(2);
      expect(
        queued.map((m) => (m.body as CheckBody).recipientId).sort(),
      ).toEqual(buyers.map((b) => b.id).sort());
      for (const m of queued) {
        expect(m.options).toMatchObject({ delaySeconds: 30 });
        const body = chatOfflineNotifyBodySchema.parse(m.body);
        expect(body).toMatchObject({
          eventId: envelope.eventId,
          channelId: channel.id,
          authorId: owner.id,
        });
        expect(m.options?.dedupeId).toBeUndefined();
      }
    });

    it('S24 AS-42: a banned member gets no check', async () => {
      const { owner, buyers, channel } = await room(2);
      await exec(
        t.app,
        `UPDATE "ChatChannelMember" SET status = 'BANNED' WHERE "channelId" = :id AND "userId" = :userId`,
        { id: channel.id, userId: buyers[1].id },
      );
      const { envelope } = await send(owner, channel.id);
      await scheduler.project([envelope]);
      expect(bodies().map((b) => b.recipientId)).toEqual([buyers[0].id]);
    });

    it('S24 AS-42: a channel with 51 active members gets no check, one with 50 does', async () => {
      const { owner, channel } = await room(1);
      await exec(
        t.app,
        `INSERT INTO "ChatChannelMember" (id, "channelId", "userId", role, status, "lastReadSeq", "createdAt", "updatedAt")
         SELECT uuidv7(), :id, uuidv7(), 'MEMBER', 'ACTIVE', 0, now(), now() FROM generate_series(1, 49)`,
        { id: channel.id },
      );
      const { envelope } = await send(owner, channel.id);
      const [{ n }] = await rows<{ n: number }>(
        t.app,
        `SELECT "activeMemberCount" AS n FROM "ChatChannel" WHERE id = :id`,
        { id: channel.id },
      );
      expect(n).toBe(51);
      await scheduler.project([envelope]);
      expect(scheduled()).toHaveLength(0);

      await exec(
        t.app,
        `UPDATE "ChatChannelMember" SET status = 'BANNED' WHERE id = (SELECT id FROM "ChatChannelMember" WHERE "channelId" = :id AND role = 'MEMBER' LIMIT 1)`,
        { id: channel.id },
      );
      await scheduler.project([envelope]);
      expect(scheduled()).toHaveLength(49);
    });
  });

  describe('the decision (AS-43)', () => {
    it('S24 AS-43: nothing in the way is notified, and exactly one chat.message_escalated event is emitted', async () => {
      const { owner, buyer, channel } = await room();
      const { envelope } = await send(owner, channel.id);
      expect(await check.run(bodyFor(envelope, buyer.id))).toBe('notified');
      expect(await escalations(buyer.id)).toHaveLength(1);
    });

    it('S24 AS-43: read, online, deleted and ineligible recipients emit nothing', async () => {
      const { owner, buyers, channel } = await room(5);
      const [reader, onliner, deleted, left, archivedOne] = buyers;
      void archivedOne;
      const { envelope } = await send(owner, channel.id);
      const seq = (envelope.payload as { seq: number }).seq;

      await t
        .as(reader)
        .post(`/api/chat/channels/${channel.id}/read`)
        .send({ seq });
      expect(await check.run(bodyFor(envelope, reader.id))).toBe('read');

      await t.as(onliner).post('/api/chat/presence/heartbeat');
      expect(await check.run(bodyFor(envelope, onliner.id))).toBe('online');

      await exec(
        t.app,
        `UPDATE "ChatMessage" SET "deletedAt" = now() WHERE id = :id`,
        { id: (envelope.payload as { messageId: string }).messageId },
      );
      expect(await check.run(bodyFor(envelope, deleted.id))).toBe('deleted');

      await exec(
        t.app,
        `UPDATE "ChatChannelMember" SET status = 'BANNED' WHERE "channelId" = :id AND "userId" = :userId`,
        { id: channel.id, userId: left.id },
      );
      expect(await check.run(bodyFor(envelope, left.id))).toBe('ineligible');
      expect(await escalations()).toHaveLength(0);
    });

    it('S24 AS-43: a recipient who is no longer a member, and an archived channel, are ineligible', async () => {
      const { owner, buyers, channel } = await room(2);
      const { envelope } = await send(owner, channel.id);
      await exec(
        t.app,
        `DELETE FROM "ChatChannelMember" WHERE "channelId" = :id AND "userId" = :userId`,
        { id: channel.id, userId: buyers[0].id },
      );
      expect(await check.run(bodyFor(envelope, buyers[0].id))).toBe(
        'ineligible',
      );
      await exec(
        t.app,
        `UPDATE "ChatChannel" SET "isArchived" = true, "archivedAt" = now() WHERE id = :id`,
        { id: channel.id },
      );
      expect(await check.run(bodyFor(envelope, buyers[1].id))).toBe(
        'ineligible',
      );
      expect(await escalations()).toHaveLength(0);
    });

    it('S24 AS-43: the whole path works: message, relay row, scheduler, delivery of the delayed check, escalation', async () => {
      const { owner, buyer, channel } = await room();
      const { envelope } = await send(owner, channel.id);
      await scheduler.project([envelope]);
      await t.queue.drain(CHAT_OFFLINE_QUEUE);
      const [event] = await escalations(buyer.id);
      expect(event.payload.aggregateId).toBe(buyer.id);
    });
  });

  describe('one push per window (AS-44)', () => {
    it('S24 AS-44: a second check inside 5 minutes is coalesced, one after is notified, another channel is its own window', async () => {
      const w = await seedWorld(t);
      const w2 = await seedWorld(t);
      const first = await openChannel(t, w);
      const second = await openChannel(t, w2);
      const buyer = await t.user();
      await t.as(buyer).post(`/api/chat/channels/${first.id}/join`);
      await t.as(buyer).post(`/api/chat/channels/${second.id}/join`);
      const m1 = await send(w.owner, first.id, 'one');
      const m2 = await send(w.owner, first.id, 'two');
      const m3 = await send(w.owner, first.id, 'three');
      const other = await send(w2.owner, second.id, 'elsewhere');

      expect(await check.run(bodyFor(m1.envelope, buyer.id))).toBe('notified');
      await at(299 * SEC);
      expect(await check.run(bodyFor(m2.envelope, buyer.id))).toBe('coalesced');
      await at(301 * SEC);
      expect(await check.run(bodyFor(m3.envelope, buyer.id))).toBe('notified');
      expect(await escalations(buyer.id)).toHaveLength(2);

      await at(60 * SEC);
      expect(await check.run(bodyFor(other.envelope, buyer.id))).toBe(
        'notified',
      );
      expect(await escalations(buyer.id)).toHaveLength(3);
    });

    it('S24 AS-44: a burst of 20 messages is one event for the first check and coalesced for the rest', async () => {
      const { owner, buyer, channel } = await room();
      const envelopes: EventEnvelope[] = [];
      for (let i = 0; i < 20; i++) {
        if (i % 8 === 0) await clearRateLimits(t.app);
        envelopes.push((await send(owner, channel.id, `burst ${i}`)).envelope);
      }
      const outcomes: string[] = [];
      for (const e of envelopes)
        outcomes.push(await check.run(bodyFor(e, buyer.id)));
      expect(outcomes).toEqual(['notified', ...Array(19).fill('coalesced')]);
      expect(await escalations(buyer.id)).toHaveLength(1);
    });
  });

  describe('the stores around it are down (AS-45)', () => {
    it('S24 AS-45: with presence unreachable the recipient counts as offline, the event is emitted and the outage is counted', async () => {
      const { owner, buyer, channel } = await room();
      const { envelope } = await send(owner, channel.id);
      const before = counter('chat_presence_unavailable_total');
      await fast.deny('presence:');
      try {
        expect(await check.run(bodyFor(envelope, buyer.id))).toBe('notified');
      } finally {
        await fast.allow();
      }
      expect(counter('chat_presence_unavailable_total')).toBe(before + 1);
      expect(await escalations(buyer.id)).toHaveLength(1);
    });

    it('S24 AS-45: with the coalescing store unreachable the event is still emitted, and its dedupeKey stops a second delivery', async () => {
      const { owner, buyer, channel } = await room();
      const { envelope, message } = await send(owner, channel.id);
      await fast.deny('chat:notified');
      try {
        expect(await check.run(bodyFor(envelope, buyer.id))).toBe('notified');
        expect(await check.run(bodyFor(envelope, buyer.id))).toBe('notified');
      } finally {
        await fast.allow();
      }
      const events = await escalations(buyer.id);
      expect(events).toHaveLength(2);
      const keys = events.map(
        (e) => (e.payload.payload as { dedupeKey: string }).dedupeKey,
      );
      expect(new Set(keys)).toEqual(
        new Set([`chat:${message.id}:${buyer.id}`]),
      );
    });
  });

  describe('delivery and poison messages (AS-46)', () => {
    it('S24 AS-46: the same chat.message_posted delivered twice gives one escalation per recipient', async () => {
      const { owner, buyer, channel } = await room();
      const { envelope } = await send(owner, channel.id);
      await scheduler.project([envelope]);
      await scheduler.project([envelope]);
      expect(scheduled()).toHaveLength(2);
      expect(
        new Set(bodies().map((b) => `${b.eventId}:${b.recipientId}`)).size,
      ).toBe(1);
      await t.queue.drain(CHAT_OFFLINE_QUEUE);
      expect(await escalations(buyer.id)).toHaveLength(1);
    });

    it('S24 AS-46: events for seq 7 then seq 6 are both scheduled and each check decides by its own seq', async () => {
      const { owner, buyer, channel } = await room();
      const envelopes: EventEnvelope[] = [];
      for (let i = 0; i < 7; i++)
        envelopes.push((await send(owner, channel.id, `m${i + 1}`)).envelope);
      const [seq6, seq7] = [envelopes[5], envelopes[6]];
      await t
        .as(buyer)
        .post(`/api/chat/channels/${channel.id}/read`)
        .send({ seq: 6 });
      await scheduler.project([seq7]);
      await scheduler.project([seq6]);
      expect(scheduled()).toHaveLength(2);
      expect(await check.run(bodyFor(seq6, buyer.id))).toBe('read');
      expect(await check.run(bodyFor(seq7, buyer.id))).toBe('notified');
    });

    it.each<[string, (e: EventEnvelope) => EventEnvelope]>([
      [
        'a missing channelId',
        (e) => ({
          ...e,
          payload: { ...(e.payload as object), channelId: undefined },
        }),
      ],
      [
        'a non-integer seq',
        (e) => ({ ...e, payload: { ...(e.payload as object), seq: 1.5 } }),
      ],
      ['an unknown version', (e) => ({ ...e, version: 99 })],
    ])(
      'S24 AS-46: %s is rejected to the dead-letter queue with no check created',
      async (_label, break_) => {
        const { owner, channel } = await room();
        const { envelope } = await send(owner, channel.id);
        await expect(
          scheduler.project([break_(envelope)]),
        ).rejects.toBeInstanceOf(PermanentError);
        expect(scheduled()).toHaveLength(0);
      },
    );

    it('S24 AS-46: a malformed queue body goes to the dead-letter queue and never reaches the check', async () => {
      await t.queue.enqueue(CHAT_OFFLINE_QUEUE, { recipientId: 'x' });
      await t.queue.drain(CHAT_OFFLINE_QUEUE);
      expect(t.queue.deadLettered.map((d) => d.reason)).toEqual([
        'SCHEMA_INVALID',
      ]);
      expect(await escalations()).toHaveLength(0);
    });

    it('S24 AS-46: the queue is defined with a dead-letter queue and options that fit a standard queue (L-001, L-002)', () => {
      const conf = readFileSync(
        join(__dirname, '../../../../../infra/docker/elasticmq/elasticmq.conf'),
        'utf8',
      );
      expect(conf).toMatch(/chat-offline-notify-dlq \{\}/);
      expect(conf).toMatch(
        /chat-offline-notify \{[^\n]*deadLettersQueue \{ name = "chat-offline-notify-dlq", maxReceiveCount = 5 \}/,
      );
      expect(CHAT_OFFLINE_QUEUE.endsWith('.fifo')).toBe(false);
    });
  });

  describe('when emitting fails (AS-47)', () => {
    it('S24 AS-47: a refused append keeps the window open, is counted, and a retry emits exactly once and consumes the window', async () => {
      const { owner, buyer, channel } = await room();
      const { envelope } = await send(owner, channel.id);
      const outbox = t.app.get(OutboxService);
      const original = outbox.append.bind(outbox);
      let refuse = true;
      outbox.append = ((...args: Parameters<OutboxService['append']>) => {
        if (
          refuse &&
          args[0] &&
          JSON.stringify(args[0]).includes('chat.message_escalated')
        )
          return Promise.reject(new Error('outbox refused'));
        return original(...args);
      }) as OutboxService['append'];
      const failed = () => counter('chat_escalation_failed_total');
      const before = failed();
      try {
        await expect(check.run(bodyFor(envelope, buyer.id))).rejects.toThrow(
          'outbox refused',
        );
        await expect(check.run(bodyFor(envelope, buyer.id))).rejects.toThrow(
          'outbox refused',
        );
        expect(failed()).toBe(before + 2);
        expect(await escalations(buyer.id)).toHaveLength(0);
        refuse = false;
        expect(await check.run(bodyFor(envelope, buyer.id))).toBe('notified');
        expect(await escalations(buyer.id)).toHaveLength(1);
        expect(await check.run(bodyFor(envelope, buyer.id))).toBe('coalesced');
        expect(await escalations(buyer.id)).toHaveLength(1);
      } finally {
        outbox.append = original;
      }
    });
  });

  describe('the event (AS-48)', () => {
    it('S24 AS-48: chat.message_escalated v1 carries the contract fields, a preview of at most 120 characters, no author name or e-mail, and is keyed by the recipient', async () => {
      const { owner, buyer, channel } = await room();
      const long = 'x'.repeat(300);
      const { envelope, message } = await send(owner, channel.id, long);
      expect(await check.run(bodyFor(envelope, buyer.id))).toBe('notified');
      const [event] = await escalations(buyer.id);
      expect(event.payload).toMatchObject({
        type: 'chat.message_escalated',
        version: 1,
        aggregateType: 'chat',
        aggregateId: buyer.id,
      });
      expect(event.payload.payload).toEqual({
        recipientId: buyer.id,
        channelId: channel.id,
        channelTitle: channel.title,
        messageId: message.id,
        seq: message.seq,
        authorId: owner.id,
        preview: 'x'.repeat(120),
        dedupeKey: `chat:${message.id}:${buyer.id}`,
      });
      const scan = JSON.stringify(event.payload);
      expect(scan).not.toContain(owner.email);
      expect(scan).not.toContain(owner.email.split('@')[0]);
      expect(
        chatConsumedSchemas['chat.message_escalated'].safeParse(
          event.payload.payload,
        ).success,
      ).toBe(true);
    });
  });
});
