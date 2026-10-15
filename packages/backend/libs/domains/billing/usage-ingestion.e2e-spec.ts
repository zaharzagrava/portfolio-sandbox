import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { LlmCallCompleted } from '@app/infrastructure/llm';
import { UsageRecorded } from './application/events/usage-events';
import { USAGE_STORE, type UsageStorePort } from './domain/ports';
import {
  LlmUsageConsumer,
  UsageRecordedConsumer,
} from './infra/usage.consumers';
import { createBillingApp, type BillingTestApp } from './testing/billing-app';

const NOW = '2026-04-10T12:00:00.000Z';
const APRIL = {
  from: new Date('2026-04-01T00:00:00.000Z'),
  to: new Date('2026-05-01T00:00:00.000Z'),
};
const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

describe('Billing: usage ingestion', () => {
  let t: BillingTestApp;
  let store: UsageStorePort;
  let clickhouse: ClickHouseService;

  beforeAll(async () => {
    t = await createBillingApp({ realUsage: true });
    store = t.app.get<UsageStorePort>(USAGE_STORE, { strict: false });
    clickhouse = t.app.get(ClickHouseService, { strict: false });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    t.clock.set(new Date(NOW));
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const usage = () => t.deliver(UsageRecordedConsumer);
  const llm = () => t.deliver(LlmUsageConsumer);
  const total = (subjectId: string, name = 'api.calls', w = APRIL) =>
    store.total(subjectId, { metric: name, from: w.from, to: w.to });

  const recorded = (
    subjectId: string,
    over: Partial<{ metric: string; quantity: number; ts: string }> = {},
    eventId: string = uuidv7(),
  ) => ({
    ...UsageRecorded.create(subjectId, 0, {
      metric: over.metric ?? 'api.calls',
      quantity: over.quantity ?? 120,
      ts: over.ts ?? '2026-04-10T11:59:00.000Z',
    }),
    eventId,
  });
  /** A valid envelope whose payload is then changed to something the producer-side check would refuse. */
  const tampered = (subjectId: string, patch: Record<string, unknown>) => {
    const envelope = recorded(subjectId);
    Object.assign(envelope.payload, patch);
    return envelope;
  };

  const callPayload = (
    subjectId: string,
    over: Record<string, unknown> = {},
  ) => ({
    userId: subjectId,
    subjectId,
    metric: 'llm.assistant.tokens',
    billableTokens: 1830,
    conversationId: 'conv-1',
    messageId: 'msg-1',
    callId: 'call-1',
    purpose: 'chat' as const,
    requestedModel: 'm',
    model: 'm',
    outcome: 'completed' as const,
    ttftMs: 120,
    durationMs: 800,
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicros: 55,
    usageEstimated: false,
    stopReason: 'end_turn',
    toolCalls: 0,
    ...over,
  });
  const call = (
    callId: string,
    subjectId: string,
    over: Record<string, unknown> = {},
    eventId: string = uuidv7(),
  ) => ({
    ...LlmCallCompleted.create(
      callId,
      0,
      callPayload(subjectId, { callId, ...over }),
    ),
    eventId,
  });

  describe('S18 AS-22 / AS-23 / AS-24 / AS-26: counting', () => {
    it('S18 AS-22: an accepted event raises the total, is counted, and the row carries subject, metric, quantity, ts, event id and ingestion instant', async () => {
      const a = uuidv4();
      const ingested = metric('usage_events_ingested_total', {
        metric_class: 'api',
      });

      const result = await usage().deliver(recorded(a, {}, 'E1'));

      expect(result.counts.applied).toBe(1);
      expect(await total(a)).toBe(120);
      expect(
        metric('usage_events_ingested_total', { metric_class: 'api' }),
      ).toBe(ingested + 1);
      const rows = await clickhouse.query<Record<string, unknown>>(
        `SELECT event_id, subject_id, metric, toString(quantity) AS quantity,
                formatDateTime(ts, '%Y-%m-%d %H:%i:%S', 'UTC') AS ts,
                formatDateTime(ingested_at, '%Y-%m-%d %H:%i:%S', 'UTC') AS ingested_at
           FROM usage_events FINAL WHERE subject_id = {a:String}`,
        { a },
      );
      expect(rows).toEqual([
        {
          event_id: 'E1',
          subject_id: a,
          metric: 'api.calls',
          quantity: '120',
          ts: '2026-04-10 11:59:00',
          ingested_at: '2026-04-10 12:00:00',
        },
      ]);
    });

    it('S18 AS-23: the same event delivered twice, and again after a restart, counts once; another event id with the same payload counts', async () => {
      const a = uuidv4();
      const first = await usage().deliver(
        recorded(a, {}, 'E1'),
        recorded(a, {}, 'E1'),
      );
      expect(first.counts).toEqual({ applied: 1, duplicate: 1, stale: 0 });
      // a consumer restart: a new delivery object, the same stores
      const again = await t
        .deliver(UsageRecordedConsumer)
        .deliver(recorded(a, {}, 'E1'));
      expect(again.counts.duplicate).toBe(1);
      expect(await total(a)).toBe(120);

      await usage().deliver(recorded(a, {}, 'E2'));
      expect(await total(a)).toBe(240);
    });

    it('S18 AS-23: a crash between the store write and the inbox commit re-inserts the same identity, which collapses at read time', async () => {
      const a = uuidv4();
      const record = {
        identity: 'E9',
        subjectId: a,
        metric: 'api.calls',
        quantity: 120,
        ts: new Date('2026-04-10T11:59:00.000Z'),
      };
      await store.insert([record], new Date(NOW));
      await store.insert([record], new Date('2026-04-10T12:00:05.000Z'));
      expect(await total(a)).toBe(120);
    });

    it('S18 AS-24: any delivery order of three events gives the same totals per period', async () => {
      const events = [
        { id: 'T1', quantity: 10, ts: '2026-04-05T10:00:00.000Z' },
        { id: 'T2', quantity: 20, ts: '2026-04-20T10:00:00.000Z' },
        { id: 'T3', quantity: 40, ts: '2026-05-03T10:00:00.000Z' },
      ];
      const orders = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
      ];
      const may = { from: APRIL.to, to: new Date('2026-06-01T00:00:00.000Z') };
      t.clock.set(new Date('2026-05-04T08:00:00.000Z'));
      const seen = new Set<string>();
      for (const order of orders) {
        const a = uuidv4();
        for (const i of order)
          await usage().deliver(
            recorded(
              a,
              { quantity: events[i].quantity, ts: events[i].ts },
              `${a}-${events[i].id}`,
            ),
          );
        seen.add(
          JSON.stringify([await total(a), await total(a, 'api.calls', may)]),
        );
      }
      expect([...seen]).toEqual([JSON.stringify([30, 40])]);
    });

    it('S18 AS-26: an event of April 28 processed on May 3 is accepted into April; its ingestion instant is May 3', async () => {
      const a = uuidv4();
      t.clock.set(new Date('2026-05-03T09:00:00.000Z'));
      await usage().deliver(
        recorded(a, { ts: '2026-04-28T10:00:00.000Z', quantity: 77 }),
      );
      expect(await total(a)).toBe(77);
      expect(
        await total(a, 'api.calls', {
          from: APRIL.to,
          to: new Date('2026-06-01T00:00:00.000Z'),
        }),
      ).toBe(0);
      const [row] = await clickhouse.query<{ ingested: string }>(
        `SELECT formatDateTime(ingested_at, '%Y-%m-%d %H:%i:%S', 'UTC') AS ingested FROM usage_events FINAL WHERE subject_id = {a:String}`,
        { a },
      );
      expect(row.ingested).toBe('2026-05-03 09:00:00');
    });

    it('S18 AS-25: events on the period boundary land in the period they belong to, through the store', async () => {
      const a = uuidv4();
      t.clock.set(new Date('2026-05-01T00:01:00.000Z'));
      await usage().deliver(
        recorded(a, { ts: '2026-04-30T23:59:59.999Z', quantity: 3 }),
        recorded(a, { ts: '2026-05-01T00:00:00.000Z', quantity: 5 }),
      );
      expect(await total(a)).toBe(3);
      expect(
        await total(a, 'api.calls', {
          from: APRIL.to,
          to: new Date('2026-06-01T00:00:00.000Z'),
        }),
      ).toBe(5);
    });
  });

  describe('S18 AS-27: LLM calls', () => {
    it('S18 AS-27: billable tokens are counted on the subject and metric of the event, once per call whatever the envelope', async () => {
      const u = uuidv4();
      const tokens = () => total(u, 'llm.assistant.tokens');
      await llm().deliver(call('c1', u));
      expect(await tokens()).toBe(1830);

      // a producer retry: a NEW envelope for the same call
      const retry = await llm().deliver(call('c1', u, {}, uuidv7()));
      expect(retry.counts.duplicate).toBe(0);
      expect(await tokens()).toBe(1830);

      await llm().deliver(call('c2', u, { billableTokens: 70 }));
      expect(await tokens()).toBe(1900);
    });

    it('S18 AS-27: zero billable tokens record nothing and are counted as ignored', async () => {
      const u = uuidv4();
      const ignored = metric('usage_events_ignored_total', {
        reason: 'zero_quantity',
      });
      await llm().deliver(call('c0', u, { billableTokens: 0 }));
      expect(await total(u, 'llm.assistant.tokens')).toBe(0);
      expect(
        metric('usage_events_ignored_total', { reason: 'zero_quantity' }),
      ).toBe(ignored + 1);
    });

    it('S18 AS-27: extraction tokens bill a shop under their own metric', async () => {
      const shop = uuidv4();
      await llm().deliver(
        call('k1', shop, {
          metric: 'llm.kyc_extraction.tokens',
          billableTokens: 400,
          purpose: 'extraction',
        }),
      );
      expect(await total(shop, 'llm.kyc_extraction.tokens')).toBe(400);
      expect(await total(shop, 'llm.assistant.tokens')).toBe(0);
    });

    it('S18 AS-27: an anonymous RAG call, whatever its outcome, is stored as platform cost under the anonymous subject', async () => {
      const callIds = ['r1', 'r2', 'r3'].map((n) => `${n}-${uuidv4()}`);
      for (const [i, outcome] of (
        ['failed', 'refused', 'aborted'] as const
      ).entries())
        await llm().deliver(
          call(callIds[i], 'anonymous', {
            metric: 'llm.rag.tokens',
            purpose: 'rag',
            outcome,
            billableTokens: 5,
            usageEstimated: true,
          }),
        );
      const rows = await clickhouse.query<{ n: string }>(
        `SELECT toString(count()) AS n FROM usage_events FINAL WHERE subject_id = 'anonymous' AND event_id IN ({ids:Array(String)})`,
        { ids: callIds.map((id) => `llm:${id}`) },
      );
      expect(rows[0].n).toBe('3');
    });

    it('S18 AS-22: a deterministic api.calls event id per (shop, metric, minute, sequence) is accepted and counts once (S42)', async () => {
      const shop = uuidv4();
      const eventId = `api:${shop}:api.calls:2026-04-10T11:58:0`;
      await usage().deliver(
        recorded(shop, { quantity: 9 }, eventId),
        recorded(shop, { quantity: 9 }, eventId),
      );
      expect(await total(shop)).toBe(9);
    });
  });

  describe('S18 AS-28: validation, one class each', () => {
    const rejected = (reason: string) =>
      metric('usage_events_rejected_total', { reason });

    it.each([
      ['unknown metric', { metric: 'api.calls2' }, 'unknown_metric'],
      [
        'unknown LLM metric',
        { metric: 'llm.assistant.minutes' },
        'unknown_metric',
      ],
      ['quantity 0', { quantity: 0 }, 'invalid_payload'],
      ['quantity -5', { quantity: -5 }, 'invalid_payload'],
      ['quantity 1.5', { quantity: 1.5 }, 'invalid_payload'],
      ['quantity "10"', { quantity: '10' }, 'invalid_payload'],
      [
        'quantity above 1,000,000,000',
        { quantity: 1_000_000_001 },
        'invalid_payload',
      ],
      ['malformed ts', { ts: 'yesterday' }, 'invalid_payload'],
      [
        'ts more than 5 minutes ahead',
        { ts: '2026-04-10T12:05:01.000Z' },
        'ts_in_future',
      ],
      ['ts older than 90 days', { ts: '2026-01-09T11:00:00.000Z' }, 'too_old'],
    ])(
      'S18 AS-28: %s is dead-lettered as %s and writes nothing',
      async (_name, patch, reason) => {
        const a = uuidv4();
        const before = rejected(reason);

        const result = await usage().deliver(tampered(a, patch));

        expect(result.deadLetters).toEqual([
          { code: 'HANDLER_FAILED', reason },
        ]);
        expect(rejected(reason)).toBe(before + 1);
        expect(await total(a)).toBe(0);
        const [row] = await clickhouse.query<{ n: string }>(
          `SELECT toString(count()) AS n FROM usage_events FINAL WHERE subject_id = {a:String}`,
          { a },
        );
        expect(row.n).toBe('0');
      },
    );

    it('S18 AS-28: a missing subject is dead-lettered as invalid_payload', async () => {
      const envelope = recorded(uuidv4());
      envelope.aggregateId = '';
      const before = rejected('invalid_payload');
      const result = await usage().deliver(envelope);
      expect(result.deadLetters).toEqual([
        { code: 'HANDLER_FAILED', reason: 'invalid_payload' },
      ]);
      expect(rejected('invalid_payload')).toBe(before + 1);
    });

    it('S18 AS-28: an LLM call with an unknown metric is dead-lettered with its class', async () => {
      const u = uuidv4();
      const result = await llm().deliver(call('bad', u, { metric: 'tokens' }));
      expect(result.deadLetters).toEqual([
        { code: 'HANDLER_FAILED', reason: 'unknown_metric' },
      ]);
      expect(await total(u, 'tokens')).toBe(0);
    });

    it('S18 AS-28: unknown extra fields are ignored', async () => {
      const a = uuidv4();
      const envelope = recorded(a);
      Object.assign(envelope.payload, {
        extra: { nested: [1, 2] },
        other: 'x',
      });
      const result = await usage().deliver(envelope);
      expect(result.deadLetters).toEqual([]);
      expect(await total(a)).toBe(120);
    });
  });

  describe('S18 AS-29 / AS-30 / AS-31: poison, failed writes and duplicate batches', () => {
    it('S18 AS-29: a poison message between two valid ones is dead-lettered and both valid ones are counted', async () => {
      const a = uuidv4();
      const result = await usage().deliverBatch(
        recorded(a, { quantity: 10 }),
        tampered(a, { quantity: -1 }),
        recorded(a, { quantity: 32 }),
      );
      expect(result.deadLetters).toHaveLength(1);
      expect(result.counts.applied).toBe(2);
      expect(await total(a)).toBe(42);
    });

    it('S18 AS-30: a rejected write is not acknowledged and counts nothing; after the store recovers the redelivery counts exactly once (VII.9)', async () => {
      const a = uuidv4();
      const event = recorded(a, { quantity: 15 }, 'E30');
      const spy = jest
        .spyOn(clickhouse, 'insert')
        .mockRejectedValue(new Error('Code: 242. TABLE_IS_READ_ONLY'));

      await expect(usage().deliver(event)).rejects.toThrow();
      expect(await total(a)).toBe(0);
      // not acknowledged: no inbox record survives, so the redelivery is treated as new
      const [inbox] = await t.sql<{ n: string }>(
        `SELECT count(*)::text AS n FROM "ProcessedWebhookEvent" WHERE "provider" = 'billing-usage-recorded' AND "eventId" = 'E30'`,
      );
      expect(inbox.n).toBe('0');

      spy.mockRestore();
      const redelivered = await usage().deliver(event);
      expect(redelivered.counts.applied).toBe(1);
      expect(await total(a)).toBe(15);
      expect((await usage().deliver(event)).counts.duplicate).toBe(1);
      expect(await total(a)).toBe(15);
    });

    it('S18 AS-31: a batch of 100 events with 10 duplicates of earlier ids counts the 90 distinct ones', async () => {
      const a = uuidv4();
      const distinct = Array.from({ length: 90 }, (_, i) =>
        recorded(a, { quantity: 1 }, `${a}-${i}`),
      );
      const duplicates = distinct.slice(0, 10);
      const result = await usage().deliverBatch(...distinct, ...duplicates);
      expect(result.counts.applied).toBe(90);
      expect(result.counts.duplicate).toBe(10);
      expect(await total(a)).toBe(90);
    });
  });

  describe('S18 SC-001: exactness under duplicates, replays, reordering and crashes', () => {
    it('10,000 events with random duplicates, replays, reordering and failed writes: every total equals the distinct events, exactly', async () => {
      // a seeded generator keeps a failing run reproducible
      let seed = 20260410;
      const random = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      };
      const pick = <T>(items: T[]) =>
        items[Math.floor(random() * items.length)];
      const subjects = Array.from({ length: 20 }, () => uuidv4());
      const metrics = ['api.calls', 'llm.assistant.tokens', 'llm.rag.tokens'];
      const expected = new Map<string, number>();
      const distinct = Array.from({ length: 10_000 }, (_, i) => {
        const subjectId = pick(subjects);
        const metricName = pick(metrics);
        const quantity = 1 + Math.floor(random() * 50);
        const day = 1 + Math.floor(random() * 9);
        expected.set(
          `${subjectId}|${metricName}`,
          (expected.get(`${subjectId}|${metricName}`) ?? 0) + quantity,
        );
        return recorded(
          subjectId,
          { metric: metricName, quantity, ts: `2026-04-0${day}T10:00:00.000Z` },
          `sc001-${subjectId}-${i}`,
        );
      });
      // 25% replayed, then shuffled
      const stream = [...distinct, ...distinct.filter(() => random() < 0.25)];
      for (let i = stream.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [stream[i], stream[j]] = [stream[j], stream[i]];
      }

      // batches of random size; one in six hits a store that rejects the write (a crash before the commit)
      const realInsert = clickhouse.insert.bind(clickhouse);
      let failures = 0;
      let cursor = 0;
      while (cursor < stream.length) {
        const size = 1 + Math.floor(random() * 400);
        const batch = stream.slice(cursor, cursor + size);
        if (random() < 1 / 6) {
          const spy = jest
            .spyOn(clickhouse, 'insert')
            .mockRejectedValueOnce(new Error('write failed'));
          await expect(usage().deliverBatch(...batch)).rejects.toThrow();
          failures++;
          spy.mockRestore();
        }
        await usage().deliverBatch(...batch); // the redelivery (or the first delivery)
        cursor += size;
        void realInsert;
      }

      expect(failures).toBeGreaterThan(0);
      for (const subjectId of subjects) {
        const totals = await store.totalsByMetric(
          subjectId,
          APRIL.from,
          APRIL.to,
        );
        for (const metricName of metrics)
          expect(totals.get(metricName) ?? 0).toBe(
            expected.get(`${subjectId}|${metricName}`) ?? 0,
          );
      }
    }, 300_000);
  });
});
