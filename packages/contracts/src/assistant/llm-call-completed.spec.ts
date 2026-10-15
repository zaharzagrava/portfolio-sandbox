import {
  LLM_CALL_COMPLETED_PURPOSES,
  llmCallCompletedPayloadV1Schema,
  llmCallCompletedV1,
} from './llm-call-completed.ts';

const ok = (r: { success: boolean }) => r.success;

const payload = {
  userId: 'u1',
  subjectId: 'u1',
  metric: 'llm.assistant.tokens',
  billableTokens: 154,
  conversationId: 'c1',
  messageId: 'm1',
  callId: 'm1:1',
  purpose: 'chat',
  requestedModel: 'claude-primary',
  model: 'claude-fallback',
  outcome: 'completed',
  ttftMs: 420,
  durationMs: 1800,
  inputTokens: 120,
  outputTokens: 30,
  cacheReadTokens: 50,
  cacheWriteTokens: 4,
  costMicros: 900,
  usageEstimated: false,
  stopReason: 'end_turn',
  toolCalls: 1,
};
const envelope = {
  eventId: '0192b0a0-0000-5000-8000-000000000001',
  type: 'llm.call_completed',
  version: 1,
  occurredAt: '2026-10-15T12:00:00.000Z',
  aggregateId: 'm1:1',
  payload,
};

describe('S46 llm.call_completed v1 contract (parse tests)', () => {
  it('S46 AS-73: a complete envelope parses', () => {
    expect(ok(llmCallCompletedV1.safeParse(envelope))).toBe(true);
  });

  it('S46 AS-73: the purposes are chat, summary, extraction and rag', () => {
    expect([...LLM_CALL_COMPLETED_PURPOSES]).toEqual([
      'chat',
      'summary',
      'extraction',
      'rag',
    ]);
  });

  it.each(['subjectId', 'metric', 'billableTokens', 'callId'])(
    'S46 AS-73: the billing field %s is required',
    (field) => {
      const rest: Record<string, unknown> = { ...payload };
      delete rest[field];
      expect(ok(llmCallCompletedPayloadV1Schema.safeParse(rest))).toBe(false);
    },
  );

  it.each<[string, Record<string, unknown>]>([
    ['negative billableTokens', { billableTokens: -1 }],
    ['fractional billableTokens', { billableTokens: 1.5 }],
    ['negative inputTokens', { inputTokens: -1 }],
    ['negative costMicros', { costMicros: -1 }],
    ['fractional costMicros', { costMicros: 0.5 }],
    ['an unknown purpose', { purpose: 'translate' }],
    ['an unknown outcome', { outcome: 'cancelled' }],
    ['an empty callId', { callId: '' }],
    ['ttftMs undefined', { ttftMs: undefined }],
    ['a non-boolean usageEstimated', { usageEstimated: 'no' }],
    ['a metric outside llm.*', { metric: 'orders.total' }],
  ])('S46 AS-69: %s is refused', (_n, patch) => {
    expect(
      ok(llmCallCompletedPayloadV1Schema.safeParse({ ...payload, ...patch })),
    ).toBe(false);
  });

  it('S46 AS-73: ttftMs is null for a call without text, and zero billable tokens are valid', () => {
    expect(
      ok(
        llmCallCompletedPayloadV1Schema.safeParse({
          ...payload,
          ttftMs: null,
          billableTokens: 0,
          outcome: 'failed',
        }),
      ),
    ).toBe(true);
  });

  it('S46 AS-73: optional scopeId and outcome are tolerated, absent or present, and added fields do not break the parser', () => {
    const noOutcome: Record<string, unknown> = { ...payload };
    delete noOutcome.outcome;
    expect(ok(llmCallCompletedPayloadV1Schema.safeParse(noOutcome))).toBe(true);
    expect(
      ok(llmCallCompletedPayloadV1Schema.safeParse({ ...payload, scopeId: 'p1' })),
    ).toBe(true);
    expect(
      ok(llmCallCompletedPayloadV1Schema.safeParse({ ...payload, addedLater: 1 })),
    ).toBe(true);
    for (const outcome of ['completed', 'refused', 'aborted', 'failed']) {
      expect(
        ok(llmCallCompletedPayloadV1Schema.safeParse({ ...payload, outcome })),
      ).toBe(true);
    }
  });

  it('S46 AS-77: an extraction record carries the shop as subject', () => {
    expect(
      ok(
        llmCallCompletedPayloadV1Schema.safeParse({
          ...payload,
          purpose: 'extraction',
          metric: 'llm.extraction.tokens',
          subjectId: 'shop-1',
          callId: 'doc-1:2',
        }),
      ),
    ).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ['version 2', { version: 2 }],
    ['another type', { type: 'llm.call_started' }],
    ['no eventId', { eventId: undefined }],
    ['no aggregateId', { aggregateId: undefined }],
    ['an invalid payload', { payload: { ...payload, callId: undefined } }],
  ])('S46 AS-73: an envelope with %s is refused', (_n, patch) => {
    expect(ok(llmCallCompletedV1.safeParse({ ...envelope, ...patch }))).toBe(
      false,
    );
  });
});
