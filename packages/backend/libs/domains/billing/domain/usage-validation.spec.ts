import {
  UsageRejected,
  validateLlmCall,
  validateUsageRecord,
} from './usage-validation';

const NOW = new Date('2026-04-10T12:00:00.000Z');

const valid = {
  identity: 'evt-1',
  subjectId: 'shop-a',
  metric: 'api.calls',
  quantity: 120,
  ts: '2026-04-10T11:59:00.000Z',
};

const reasonOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof UsageRejected) return error.reason;
    throw error;
  }
  return undefined;
};

describe('S18 usage record validation (FR-018)', () => {
  it('S18 AS-22: a valid record keeps its identity, subject, metric, quantity and instant', () => {
    expect(validateUsageRecord(valid, NOW)).toEqual({
      identity: 'evt-1',
      subjectId: 'shop-a',
      metric: 'api.calls',
      quantity: 120,
      ts: new Date('2026-04-10T11:59:00.000Z'),
    });
  });

  it('S18 AS-28: unknown extra fields are ignored', () => {
    expect(
      reasonOf(() =>
        validateUsageRecord(
          { ...valid, extra: { nested: true } } as never,
          NOW,
        ),
      ),
    ).toBeUndefined();
  });

  it.each([
    ['llm.assistant.tokens'],
    ['llm.kyc_extraction.tokens'],
    ['llm.rag.tokens'],
    ['api.calls'],
  ])('S18 AS-28: the metric %s matches the allowlist', (metric) => {
    expect(
      reasonOf(() => validateUsageRecord({ ...valid, metric }, NOW)),
    ).toBeUndefined();
  });

  it.each([
    ['api.calls2'],
    ['API.calls'],
    ['api.calls '],
    ['llm..tokens'],
    ['llm.Assistant.tokens'],
    ['llm.assistant.minutes'],
    ['llm.a_very_long_purpose_name_over_the_limit_of_32.tokens'],
    [''],
  ])('S18 AS-28: the metric %j is unknown_metric', (metric) => {
    expect(reasonOf(() => validateUsageRecord({ ...valid, metric }, NOW))).toBe(
      'unknown_metric',
    );
  });

  it.each([
    ['quantity 0', { quantity: 0 }],
    ['quantity -5', { quantity: -5 }],
    ['quantity 1.5', { quantity: 1.5 }],
    ['quantity "10"', { quantity: '10' }],
    ['quantity 1,000,000,001', { quantity: 1_000_000_001 }],
    ['quantity null', { quantity: null }],
    ['quantity NaN', { quantity: Number.NaN }],
    ['no ts', { ts: undefined }],
    ['ts not a string', { ts: 1775822400000 }],
    ['ts malformed', { ts: 'yesterday' }],
    ['ts date only', { ts: '2026-04-10' }],
    ['ts impossible date', { ts: '2026-02-30T00:00:00.000Z' }],
    ['no subject', { subjectId: undefined }],
    ['empty subject', { subjectId: '' }],
    ['subject not a string', { subjectId: 42 }],
    ['subject over 200 characters', { subjectId: 'x'.repeat(201) }],
    ['no metric', { metric: undefined }],
    ['metric not a string', { metric: 5 }],
    ['no identity', { identity: '' }],
  ])('S18 AS-28: %s is invalid_payload', (_name, patch) => {
    expect(
      reasonOf(() => validateUsageRecord({ ...valid, ...patch } as never, NOW)),
    ).toBe('invalid_payload');
  });

  it.each([
    ['exactly 1,000,000,000', 1_000_000_000],
    ['1', 1],
  ])('S18 AS-28: quantity %s is accepted', (_name, quantity) => {
    expect(
      reasonOf(() => validateUsageRecord({ ...valid, quantity }, NOW)),
    ).toBeUndefined();
  });

  it('S18 AS-28: a ts more than 5 minutes after now is ts_in_future; exactly 5 minutes is accepted', () => {
    expect(
      reasonOf(() =>
        validateUsageRecord({ ...valid, ts: '2026-04-10T12:05:00.001Z' }, NOW),
      ),
    ).toBe('ts_in_future');
    expect(
      reasonOf(() =>
        validateUsageRecord({ ...valid, ts: '2026-04-10T12:05:00.000Z' }, NOW),
      ),
    ).toBeUndefined();
  });

  it('S18 AS-28: a ts older than 90 days is too_old; exactly 90 days is accepted', () => {
    expect(
      reasonOf(() =>
        validateUsageRecord({ ...valid, ts: '2026-01-10T11:59:59.999Z' }, NOW),
      ),
    ).toBe('too_old');
    expect(
      reasonOf(() =>
        validateUsageRecord({ ...valid, ts: '2026-01-10T12:00:00.000Z' }, NOW),
      ),
    ).toBeUndefined();
  });

  it('S18 AS-26: an event of a few days ago is accepted however late it is delivered', () => {
    expect(
      validateUsageRecord({ ...valid, ts: '2026-04-07T10:00:00.000Z' }, NOW).ts,
    ).toEqual(new Date('2026-04-07T10:00:00.000Z'));
  });

  it('S18 AS-28: a ts with an offset is read as the instant it names', () => {
    expect(
      validateUsageRecord({ ...valid, ts: '2026-04-10T13:59:00+02:00' }, NOW)
        .ts,
    ).toEqual(new Date('2026-04-10T11:59:00.000Z'));
  });
});

describe('S18 LLM call validation (FR-022)', () => {
  const call = {
    aggregateId: 'c1',
    occurredAt: '2026-04-10T11:59:00.000Z',
    payload: {
      subjectId: 'user-u',
      metric: 'llm.assistant.tokens',
      billableTokens: 1830,
    },
  };

  it('S18 AS-27: the identity is llm:<aggregateId> and the quantity the billable tokens', () => {
    expect(validateLlmCall(call, NOW)).toEqual({
      kind: 'record',
      record: {
        identity: 'llm:c1',
        subjectId: 'user-u',
        metric: 'llm.assistant.tokens',
        quantity: 1830,
        ts: new Date('2026-04-10T11:59:00.000Z'),
      },
    });
  });

  it('S18 AS-27: zero billable tokens record nothing and are reported as zero_quantity', () => {
    expect(
      validateLlmCall(
        { ...call, payload: { ...call.payload, billableTokens: 0 } },
        NOW,
      ),
    ).toEqual({ kind: 'ignored', reason: 'zero_quantity' });
  });

  it('S18 AS-27: the metric of the call is the one named in the event, a shop can be billed for extraction', () => {
    const result = validateLlmCall(
      {
        ...call,
        payload: {
          subjectId: 'shop-s',
          metric: 'llm.kyc_extraction.tokens',
          billableTokens: 40,
        },
      },
      NOW,
    );
    expect(result).toMatchObject({
      kind: 'record',
      record: { subjectId: 'shop-s', metric: 'llm.kyc_extraction.tokens' },
    });
  });

  it('S18 AS-27: the anonymous subject of a RAG call is stored as platform cost', () => {
    const result = validateLlmCall(
      {
        ...call,
        payload: {
          subjectId: 'anonymous',
          metric: 'llm.rag.tokens',
          billableTokens: 7,
        },
      },
      NOW,
    );
    expect(result).toMatchObject({
      kind: 'record',
      record: { subjectId: 'anonymous', metric: 'llm.rag.tokens', quantity: 7 },
    });
  });

  it.each([
    ['negative tokens', { billableTokens: -1 }, 'invalid_payload'],
    ['fractional tokens', { billableTokens: 1.5 }, 'invalid_payload'],
    ['tokens as text', { billableTokens: '10' }, 'invalid_payload'],
    ['too many tokens', { billableTokens: 1_000_000_001 }, 'invalid_payload'],
    ['no subject', { subjectId: '' }, 'invalid_payload'],
    ['unknown metric', { metric: 'llm.assistant.words' }, 'unknown_metric'],
  ])('S18 AS-28: a call with %s is rejected as %s', (_name, patch, reason) => {
    expect(
      reasonOf(() =>
        validateLlmCall(
          { ...call, payload: { ...call.payload, ...patch } } as never,
          NOW,
        ),
      ),
    ).toBe(reason);
  });

  it('S18 AS-28: a call without an aggregate id, or too old, is rejected', () => {
    expect(
      reasonOf(() => validateLlmCall({ ...call, aggregateId: '' }, NOW)),
    ).toBe('invalid_payload');
    expect(
      reasonOf(() =>
        validateLlmCall(
          { ...call, occurredAt: '2025-01-01T00:00:00.000Z' },
          NOW,
        ),
      ),
    ).toBe('too_old');
  });
});
