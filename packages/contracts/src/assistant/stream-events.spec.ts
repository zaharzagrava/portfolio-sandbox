import {
  ASSISTANT_ERROR_CODES,
  ASSISTANT_STREAM_EVENT_NAMES,
  assistantCancelResponseSchema,
  assistantLastEventIdSchema,
  assistantStreamEventSchema,
} from './stream-events.ts';

const ok = (r: { success: boolean }) => r.success;
const ID = '0192b0a0-0000-7000-8000-000000000001';
const done = {
  event: 'done',
  stopReason: 'end_turn',
  truncated: false,
  usage: { inputTokens: 120, outputTokens: 30 },
  allowance: { used: 150, limit: 2_000_000 },
};

describe('S46 stream event contract (parse tests)', () => {
  it('S46 AS-02: exactly six event names exist', () => {
    expect([...ASSISTANT_STREAM_EVENT_NAMES]).toEqual([
      'meta',
      'text',
      'tool',
      'done',
      'refusal',
      'error',
    ]);
  });

  it.each<[string, unknown]>([
    ['meta', { event: 'meta', messageId: 'm1', conversationId: ID }],
    ['text', { event: 'text', t: 'Hello' }],
    ['tool running', { event: 'tool', id: 'tu_1', name: 'search_products', status: 'running' }],
    ['tool done', { event: 'tool', id: 'tu_1', name: 'product_details', status: 'done' }],
    ['tool failed', { event: 'tool', id: 'tu_1', name: 'pickup_near_me', status: 'failed' }],
    ['done', done],
    ['done truncated', { ...done, truncated: true, stopReason: 'max_tokens' }],
    ['provider refusal', { event: 'refusal', category: 'cyber', source: 'provider' }],
    ['moderation refusal', { event: 'refusal', category: 'violence', source: 'moderation' }],
    ['error', { event: 'error', code: 'CANCELLED' }],
    ['error with retryAfterMs', { event: 'error', code: 'PROVIDER_UNAVAILABLE', retryAfterMs: 5000 }],
  ])('S46 AS-01: a %s event parses', (_n, ev) => {
    expect(ok(assistantStreamEventSchema.safeParse(ev))).toBe(true);
  });

  it.each([...ASSISTANT_ERROR_CODES])(
    'S46 AS-02: error code %s parses',
    (code) => {
      expect(
        ok(assistantStreamEventSchema.safeParse({ event: 'error', code })),
      ).toBe(true);
    },
  );

  it('S46 AS-02: the error codes are the closed set of the generation states', () => {
    expect([...ASSISTANT_ERROR_CODES]).toEqual([
      'CANCELLED',
      'PROVIDER_UNAVAILABLE',
      'TURN_TIMEOUT',
      'GENERATION_LOST',
      'MODERATION_UNAVAILABLE',
      'SHUTTING_DOWN',
      'TOOL_LOOP_LIMIT',
      'INTERNAL',
    ]);
  });

  it.each<[string, unknown]>([
    ['an unknown event name', { event: 'thinking', t: 'x' }],
    ['no event name', { t: 'x' }],
    ['meta without conversationId', { event: 'meta', messageId: 'm1' }],
    ['meta with a user id', { event: 'meta', messageId: 'm1', conversationId: ID, userId: ID }],
    ['text with a non-string piece', { event: 'text', t: 5 }],
    ['tool with an unknown status', { event: 'tool', id: 'x', name: 'n', status: 'queued' }],
    ['tool with its input', { event: 'tool', id: 'x', name: 'n', status: 'running', input: {} }],
    ['done with a cost', { ...done, costMicros: 12 }],
    ['done with a model name', { ...done, model: 'claude-x' }],
    ['done with cache counters', { ...done, usage: { ...done.usage, cacheReadTokens: 1 } }],
    ['done without allowance', { ...done, allowance: undefined }],
    ['done with negative usage', { ...done, usage: { inputTokens: -1, outputTokens: 0 } }],
    ['refusal with an unknown source', { event: 'refusal', category: 'x', source: 'user' }],
    ['error with an unknown code', { event: 'error', code: 'BOOM' }],
    ['error with a provider message', { event: 'error', code: 'INTERNAL', message: 'x' }],
    ['error with a negative retryAfterMs', { event: 'error', code: 'INTERNAL', retryAfterMs: -1 }],
  ])('S46 AS-02: %s is refused', (_n, ev) => {
    expect(ok(assistantStreamEventSchema.safeParse(ev))).toBe(false);
  });

  it.each(['1730000000000-0', '0-0', '1730000000000-123'])(
    'S46 AS-24: Last-Event-ID %s is well formed',
    (id) => {
      expect(ok(assistantLastEventIdSchema.safeParse(id))).toBe(true);
    },
  );

  it.each([
    '',
    '1730000000000',
    '-1',
    '1-',
    'a-b',
    '1-2-3',
    ' 1-2',
    '1-2 ',
    '1.5-2',
    '1-2\n',
  ])('S46 AS-24: Last-Event-ID %j is malformed', (id) => {
    expect(ok(assistantLastEventIdSchema.safeParse(id))).toBe(false);
  });

  it('S46 AS-28: the cancel answer is {cancelling: true}', () => {
    expect(
      ok(assistantCancelResponseSchema.safeParse({ cancelling: true })),
    ).toBe(true);
    expect(
      ok(assistantCancelResponseSchema.safeParse({ cancelling: false })),
    ).toBe(false);
    expect(ok(assistantCancelResponseSchema.safeParse({}))).toBe(false);
  });
});
