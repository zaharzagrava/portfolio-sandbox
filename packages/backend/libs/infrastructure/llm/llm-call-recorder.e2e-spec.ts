import { Logger } from '@nestjs/common';
import { eventEnvelopeSchema } from '@app/infrastructure/events/event-envelope';
import { LlmCallCompleted } from './llm-call-completed';
import { LlmCallRecord, LlmCallRecorder } from './llm-call-recorder';

const call = (over: Partial<LlmCallRecord> = {}): LlmCallRecord => ({
  subjectId: 'user-1',
  scopeId: 'conv-1',
  callId: 'msg-1:2',
  purpose: 'chat',
  metric: 'llm.assistant.tokens',
  requestedModel: 'claude-opus-5-5',
  outcome: 'completed',
  result: {
    model: 'claude-opus-5-5',
    usage: {
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 95,
      cacheWriteTokens: 10,
    },
    stopReason: 'end_turn',
    content: [
      { type: 'tool_use', id: 't1', name: 'search', input: {} },
    ] as never,
  },
  ttftMs: 321,
  durationMs: 1_234,
  ...over,
});

const outbox = (failures = 0) => {
  const appended: any[] = [];
  let remaining = failures;
  let attempts = 0;
  return {
    appended,
    attempts: () => attempts,
    append: async () => undefined,
    appendStandalone: async (event: any) => {
      attempts++;
      if (remaining-- > 0) throw new Error('outbox down');
      appended.push(event);
    },
  };
};

const recorderFor = (box: ReturnType<typeof outbox>, sleeps: number[] = []) =>
  new LlmCallRecorder(box as never, {
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
  });

describe('LlmCallRecorder', () => {
  afterEach(() => jest.restoreAllMocks());

  it('S46 AS-73: the appended event parses with the llm.call_completed v1 schema and carries the fields S18 requires', async () => {
    const box = outbox();

    const charged = await recorderFor(box).record(call());

    expect(charged).toEqual({ billableTokens: 1_000 + 10 + 200 + 10, costMicros: 8_069 });
    expect(box.appended).toHaveLength(1);
    // The outbox validates the envelope: the deterministic id must be one it accepts.
    expect(eventEnvelopeSchema.safeParse(box.appended[0]).success).toBe(true);
    const event = LlmCallCompleted.match(box.appended[0]);
    expect(event).not.toBeNull();
    expect(event!.aggregateId).toBe('msg-1:2');
    expect(event!.payload).toMatchObject({
      userId: 'user-1',
      subjectId: 'user-1',
      metric: 'llm.assistant.tokens',
      billableTokens: 1_220,
      conversationId: 'conv-1',
      scopeId: 'conv-1',
      messageId: 'msg-1',
      callId: 'msg-1:2',
      purpose: 'chat',
      outcome: 'completed',
      usageEstimated: false,
      toolCalls: 1,
      ttftMs: 321,
      durationMs: 1_234,
    });
  });

  it('S46 AS-73: the event id is derived from the call id: the same call gives the same id, another call another id', async () => {
    const box = outbox();
    const recorder = recorderFor(box);

    await recorder.record(call());
    await recorder.record(call());
    await recorder.record(call({ callId: 'msg-1:3' }));

    const [first, again, other] = box.appended.map((e) => e.eventId);
    expect(first).toBe(again);
    expect(other).not.toBe(first);
  });

  it('S46 AS-68: a call with zero billable tokens still produces its record, with 0 (no minimum of 1)', async () => {
    const box = outbox();

    const charged = await recorderFor(box).record(
      call({
        outcome: 'failed',
        result: {
          model: null,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          stopReason: null,
        },
        ttftMs: null,
      }),
    );

    expect(charged).toEqual({ billableTokens: 0, costMicros: 0 });
    expect(box.appended).toHaveLength(1);
    expect(box.appended[0].payload).toMatchObject({
      billableTokens: 0,
      outcome: 'failed',
      model: 'claude-opus-5-5',
      ttftMs: null,
    });
  });

  it('S46 AS-71: an outbox failure is retried 3 times with backoff, the record then succeeds and the caller sees no error', async () => {
    const box = outbox(3);
    const sleeps: number[] = [];

    await expect(
      recorderFor(box, sleeps).record(call()),
    ).resolves.toMatchObject({ billableTokens: 1_220 });

    expect(box.attempts()).toBe(4);
    expect(box.appended).toHaveLength(1);
    expect(sleeps).toEqual([50, 100, 200]); // full jitter at random 0.5 of 100, 200, 400 ms
  });

  it('S46 AS-71: when every retry fails the call still resolves, and the loss is logged with callId, subjectId, billableTokens and costMicros but no content', async () => {
    const box = outbox(99);
    const logged: string[] = [];
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((m: unknown) => void logged.push(String(m)));

    await expect(recorderFor(box).record(call())).resolves.toEqual({
      billableTokens: 1_220,
      costMicros: 8_069,
    });

    expect(box.attempts()).toBe(4);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('"callId":"msg-1:2"');
    expect(logged[0]).toContain('"subjectId":"user-1"');
    expect(logged[0]).toContain('"billableTokens":1220');
    expect(logged[0]).toContain('"costMicros":8069');
    expect(logged[0]).not.toContain('search');
  });
});
