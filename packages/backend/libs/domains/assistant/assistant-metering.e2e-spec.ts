import { Logger } from '@nestjs/common';
import { types } from 'cassandra-driver';
import { v4 } from 'uuid';
import {
  llmCallCompletedPayloadV1Schema,
  llmCallCompletedV1,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { eventIdForCall, LlmCallCompleted } from '@app/infrastructure/llm';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { createTopics, readTopic, testKafka } from '@app/test/utils/kafka-test';
import { waitFor } from '@app/test/utils/async-helpers';
import { AssistantProjectorModule } from './assistant-projector.module';
import {
  bootAssistant,
  type Harness,
  type TestUser,
} from './testing/assistant.harness';

type Payload = Record<string, string | number | boolean | null>;
const LLM_TOPIC = LlmCallCompleted.topic;

describe('Shopping assistant: metering and observability', () => {
  let h: Harness;
  let clickhouse: ClickHouseService;

  beforeAll(async () => {
    await createTopics([{ topic: LLM_TOPIC }]).catch(() => undefined);
    h = await bootAssistant({
      extraModules: [
        ProjectionsModule.forProjectors(AssistantProjectorModule.projectors, [
          AssistantProjectorModule,
        ]),
      ],
    });
    clickhouse = h.app.get(ClickHouseService);
  }, 120_000);
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
  });

  const row = async (callId: string) => {
    const rows = await waitFor(
      async () => {
        const found = await outboxRowsFor(h.app, callId);
        return found.length ? found : null;
      },
      { description: `outbox row ${callId}` },
    );
    return rows;
  };
  const payloadOf = async (callId: string): Promise<Payload> => {
    const [first] = await row(callId);
    const envelope = first.payload as { payload?: Payload };
    return (envelope.payload ?? first.payload) as Payload;
  };
  const messageId = (events: { data?: string }[]) =>
    JSON.parse(events[0].data!).messageId as string;
  const longTranscript = async (u: TestUser, c: string) => {
    for (let i = 0; i < 10; i += 3)
      await h.repository.appendTurn(
        u.id,
        c,
        types.TimeUuid.now().toString(),
        Array.from({ length: Math.min(3, 10 - i) }, (_, j) => ({
          role: ((i + j) % 2 === 0 ? 'user' : 'assistant') as
            'user' | 'assistant',
          content: JSON.stringify([
            { type: 'text', text: `${i + j}:`.padEnd(28_000, 'x') },
          ]),
          visibleText: '',
          toolNames: [] as string[],
        })),
      );
  };

  it('S46 AS-68: every model call of a turn is one durable record with the S18 fields', async () => {
    const u = await h.user();
    const c = await h.conversation(u);
    await longTranscript(u, c);
    const unknown = () => ({
      name: 'product_details',
      input: { product_id: v4() },
    });
    h.llm.script(
      { model: h.config.get('assistant_summary_model'), text: 'SUMMARY' },
      { toolUses: [unknown()] },
      { toolUses: [unknown()] },
      { text: 'final answer' },
    );

    const res = await h.ask(u, c, { text: 'dig deep' });
    expect(res.events.at(-1)!.event).toBe('done');
    const m = messageId(res.events);

    const records: Payload[] = [];
    for (const n of [0, 1, 2, 3]) {
      const [first, ...rest] = await row(`${m}:${n}`);
      expect(rest).toEqual([]);
      expect(first.aggregateId).toBe(`${m}:${n}`);
      expect(first.type).toBe('llm.call_completed');
      const parsed = llmCallCompletedV1.safeParse(first.payload);
      expect(parsed.success).toBe(true);
      expect((first.payload as { eventId: string }).eventId).toBe(
        eventIdForCall(`${m}:${n}`),
      );
      records.push(await payloadOf(`${m}:${n}`));
    }
    for (const r of records) {
      expect(r).toMatchObject({
        userId: u.id,
        subjectId: u.id,
        metric: 'llm.assistant.tokens',
        conversationId: c,
        messageId: m,
        usageEstimated: false,
      });
      expect(Number.isInteger(r.billableTokens)).toBe(true);
    }
    expect(records.map((r) => [r.callId, r.purpose, r.outcome])).toEqual([
      [`${m}:0`, 'summary', 'completed'],
      [`${m}:1`, 'chat', 'completed'],
      [`${m}:2`, 'chat', 'completed'],
      [`${m}:3`, 'chat', 'completed'],
    ]);
    expect(records[1]).toMatchObject({ stopReason: 'tool_use', toolCalls: 1 });
    expect(records[3]).toMatchObject({ stopReason: 'end_turn', toolCalls: 0 });
    // the allowance counter equals the sum of the records of the turn
    const usage = (await h.http().get('/api/assistant/usage').set(u.auth)).body
      .used;
    expect(usage).toBe(
      records.reduce((sum, r) => sum + Number(r.billableTokens), 0),
    );
  });

  it('S46 AS-68: a call with zero billable tokens still produces its record', async () => {
    const u = await h.user();
    const c = await h.conversation(u);
    h.llm.script({ text: 'free', usage: { inputTokens: 0, outputTokens: 0 } });
    const res = await h.ask(u, c, { text: 'go' });
    const record = await payloadOf(`${messageId(res.events)}:1`);
    expect(record.billableTokens).toBe(0);
    expect(record.outcome).toBe('completed');
  });

  describe('S46 AS-69: the analytics projector', () => {
    const publish = async (...values: unknown[]) => {
      const producer = testKafka().producer();
      await producer.connect();
      try {
        await producer.send({
          topic: LLM_TOPIC,
          messages: values.map((v) => ({
            key: (v as { aggregateId?: string }).aggregateId ?? 'bad',
            value: JSON.stringify(v),
          })),
        });
      } finally {
        await producer.disconnect();
      }
    };
    const callPayload = (callId: string, over: Record<string, unknown> = {}) =>
      ({
        userId: v4(),
        subjectId: v4(),
        metric: 'llm.assistant.tokens',
        billableTokens: 12,
        conversationId: v4(),
        messageId: callId.split(':')[0],
        callId,
        purpose: 'chat',
        requestedModel: 'claude-opus-5-5',
        model: 'claude-opus-5-5',
        outcome: 'completed',
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
      }) as never;
    const rows = async (callId: string) =>
      clickhouse.query<{ n: string }>(
        'SELECT count() AS n FROM llm_requests FINAL WHERE call_id = {callId:String}',
        { callId },
      );

    it('a duplicate delivery leaves one row; an invalid payload is dead-lettered and writes no row', async () => {
      const callId = `${v4()}:1`;
      const event = {
        ...LlmCallCompleted.create(callId, 0, callPayload(callId)),
        eventId: eventIdForCall(callId),
      };
      await publish(event, event);
      await waitFor(async () => Number((await rows(callId))[0].n) >= 1, {
        timeoutMs: 40_000,
        description: 'row written',
      });
      await new Promise((r) => setTimeout(r, 1_000));
      expect(Number((await rows(callId))[0].n)).toBe(1);

      const badId = `${v4()}:1`;
      const bad = {
        ...LlmCallCompleted.create(badId, 0, callPayload(badId)),
        eventId: eventIdForCall(badId),
      };
      delete (bad.payload as Record<string, unknown>).callId;
      const negative = `${v4()}:1`;
      const worse = {
        ...LlmCallCompleted.create(negative, 0, callPayload(negative)),
        eventId: eventIdForCall(negative),
      };
      (worse.payload as Record<string, unknown>).billableTokens = -5;
      const unknownPurpose = `${v4()}:1`;
      const odd = {
        ...LlmCallCompleted.create(
          unknownPurpose,
          0,
          callPayload(unknownPurpose),
        ),
        eventId: eventIdForCall(unknownPurpose),
      };
      (odd.payload as Record<string, unknown>).purpose = 'gossip';
      await publish(bad, worse, odd);

      const letters = await waitFor(
        async () => {
          const found = (await readTopic('llm-calls-log.dlq')).filter((l) =>
            [badId, negative, unknownPurpose].includes(l.key ?? ''),
          );
          return found.length === 3 ? found : null;
        },
        { timeoutMs: 40_000, description: 'three dead letters' },
      );
      expect(
        letters.every(
          (l) => l.headers['x-dlq-reason-code'] === 'INVALID_PAYLOAD',
        ),
      ).toBe(true);
      for (const id of [badId, negative, unknownPurpose])
        expect(Number((await rows(id))[0].n)).toBe(0);

      // later messages are still processed
      const after = `${v4()}:1`;
      await publish({
        ...LlmCallCompleted.create(after, 0, callPayload(after)),
        eventId: eventIdForCall(after),
      });
      await waitFor(async () => Number((await rows(after))[0].n) === 1, {
        timeoutMs: 40_000,
        description: 'later message applied',
      });
      const [stored] = await clickhouse.query<Record<string, unknown>>(
        'SELECT call_id, subject_id, metric, billable_tokens, outcome, usage_estimated FROM llm_requests FINAL WHERE call_id = {callId:String}',
        { callId: after },
      );
      expect(stored).toMatchObject({
        call_id: after,
        metric: 'llm.assistant.tokens',
        outcome: 'completed',
      });
    }, 120_000);
  });

  describe('S46 AS-70: time to first token and metrics', () => {
    it('ttft is null for a call without text; metrics move; active streams return to 0; no id in any label', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      const fallbacks = MetricsRegistry.value('assistant_fallbacks_total') ?? 0;
      h.llm.script(
        { model: h.config.get('assistant_model'), unavailable: true },
        {
          model: h.config.get('assistant_fallback_model'),
          toolUses: [{ name: 'product_details', input: { product_id: v4() } }],
        },
        // the next round tries the primary first again, and it answers
        {
          model: h.config.get('assistant_model'),
          text: 'an answer',
          chunks: 2,
        },
      );
      const res = await h.ask(u, c, { text: 'go' });
      expect(res.events.at(-1)!.event).toBe('done');
      const m = messageId(res.events);

      expect((await payloadOf(`${m}:1`)).ttftMs).toBeNull(); // the failed attempt
      expect((await payloadOf(`${m}:2`)).ttftMs).toBeNull(); // a pure tool round
      const answer = await payloadOf(`${m}:3`);
      expect(typeof answer.ttftMs).toBe('number');
      expect(answer.ttftMs as number).toBeLessThan(
        (answer.durationMs as number) + 1,
      );

      expect(MetricsRegistry.value('assistant_fallbacks_total')).toBe(
        fallbacks + 1,
      );
      expect(
        MetricsRegistry.histogramValue('assistant_ttft_seconds', {
          model: h.config.get('assistant_model'),
        })?.count,
      ).toBeGreaterThan(0);
      expect(
        MetricsRegistry.value('assistant_tokens_total', {
          model: h.config.get('assistant_fallback_model'),
          kind: 'input',
        }),
      ).toBeGreaterThan(0);
      await waitFor(
        async () => MetricsRegistry.value('assistant_active_streams') === 0,
        { description: 'active streams back to 0' },
      );
      expect(
        MetricsRegistry.value('assistant_turns_total', { outcome: 'done' }),
      ).toBeGreaterThan(0);
      expect(
        MetricsRegistry.histogramValue('assistant_turn_duration_seconds', {
          outcome: 'done',
        })?.count,
      ).toBeGreaterThan(0);

      // an abort moves the abort counter by reason
      h.config.set('assistant_detach_grace_ms', 60_000);
      const c2 = await h.conversation(u);
      h.llm.script({ text: 'x', hang: true, delayMs: 20 });
      const first = await h.ask(u, c2, { text: 'go' }, { count: 2 });
      const before =
        MetricsRegistry.value('assistant_aborts_total', { reason: 'cancel' }) ??
        0;
      await h
        .http()
        .post(`/api/assistant/messages/${messageId(first.events)}/cancel`)
        .set(u.auth);
      await waitFor(
        async () =>
          (MetricsRegistry.value('assistant_aborts_total', {
            reason: 'cancel',
          }) ?? 0) ===
          before + 1,
        { description: 'abort counted' },
      );
      await waitFor(
        async () => MetricsRegistry.value('assistant_active_streams') === 0,
        { description: 'active streams back to 0' },
      );

      for (const name of [
        'assistant_ttft_seconds',
        'assistant_turn_duration_seconds',
        'assistant_tokens_total',
        'assistant_turns_total',
        'assistant_fallbacks_total',
        'assistant_aborts_total',
        'assistant_active_streams',
        'assistant_admission_rejected_total',
        'assistant_breaker_state',
        'assistant_provider_errors_total',
      ])
        for (const labels of MetricsRegistry.labelSets(name))
          for (const value of Object.values(labels)) {
            expect(String(value)).not.toContain(u.id);
            expect(String(value)).not.toContain(c);
            expect(String(value)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
          }
    });
  });

  it('S46 AS-71: an outbox that keeps failing never fails the turn; the loss is counted and logged to re-create the record', async () => {
    const u = await h.user();
    const c = await h.conversation(u);
    h.llm.script({
      text: 'still answered',
      usage: { inputTokens: 50, outputTokens: 10 },
    });
    const outbox = h.app.get(OutboxService);
    const attempts: string[] = [];
    const failing = jest
      .spyOn(outbox, 'appendStandalone')
      .mockImplementation(async (event) => {
        attempts.push((event as { aggregateId: string }).aggregateId);
        throw new Error('outbox down');
      });
    const errors: string[] = [];
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      });
    const before =
      MetricsRegistry.value('assistant_metering_failures_total', {
        purpose: 'chat',
      }) ?? 0;
    let res;
    try {
      res = await h.ask(u, c, { text: 'go' });
      await waitFor(
        async () =>
          (MetricsRegistry.value('assistant_metering_failures_total', {
            purpose: 'chat',
          }) ?? 0) ===
          before + 1,
        { description: 'failure counted' },
      );
    } finally {
      failing.mockRestore();
      log.mockRestore();
    }
    expect(res.events.at(-1)!.event).toBe('done');
    const m = messageId(res.events);
    // the initial attempt and three retries
    expect(attempts.filter((a) => a === `${m}:1`)).toHaveLength(4);
    const line = errors.find((e) => e.includes('llm call record lost'))!;
    expect(line).toContain(`${m}:1`);
    expect(JSON.parse(line.slice(line.indexOf('{')))).toMatchObject({
      callId: `${m}:1`,
      subjectId: u.id,
      billableTokens: 60,
      costMicros: expect.any(Number),
    });
    expect(line).not.toContain('go');
    // the month counter is still charged
    expect(
      (await h.http().get('/api/assistant/usage').set(u.auth)).body.used,
    ).toBe(60);
  });

  it('S46 AS-73: the record parses with llmCallCompletedV1, additive fields present, tolerant of scopeId and outcome', async () => {
    const u = await h.user();
    const c = await h.conversation(u);
    const res = await h.ask(u, c, { text: 'go' });
    const [first] = await row(`${messageId(res.events)}:1`);
    expect(llmCallCompletedV1.parse(first.payload).payload).toMatchObject({
      subjectId: u.id,
      metric: 'llm.assistant.tokens',
      callId: `${messageId(res.events)}:1`,
    });
    const payload = await payloadOf(`${messageId(res.events)}:1`);
    expect(
      Number.isInteger(payload.billableTokens) &&
        (payload.billableTokens as number) >= 0,
    ).toBe(true);
    // an older producer without scopeId and outcome still parses
    const { scopeId: _scope, outcome: _outcome, ...older } = payload;
    expect(llmCallCompletedPayloadV1Schema.safeParse(older).success).toBe(true);
    expect(
      llmCallCompletedPayloadV1Schema.safeParse({
        ...payload,
        scopeId: c,
        outcome: 'completed',
      }).success,
    ).toBe(true);
    // the required S18 fields are mandatory
    for (const field of ['subjectId', 'metric', 'billableTokens', 'callId'])
      expect(
        llmCallCompletedPayloadV1Schema.safeParse({
          ...older,
          [field]: undefined,
        }).success,
      ).toBe(false);
  });
});
