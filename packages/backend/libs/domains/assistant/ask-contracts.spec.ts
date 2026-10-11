import {
  ragAskRequestSchema,
  ragStreamEventSchema,
} from '@marketplace-sandbox/contracts';

const ok = (
  s: { safeParse: (v: unknown) => { success: boolean } },
  v: unknown,
) => s.safeParse(v).success;

describe('W02 B-7: ask contracts', () => {
  it('W02 B-7: the question is 3 to 500 characters and nothing else is allowed', () => {
    expect(ok(ragAskRequestSchema, { question: 'abc' })).toBe(true);
    expect(ok(ragAskRequestSchema, { question: 'a'.repeat(500) })).toBe(true);
    expect(ok(ragAskRequestSchema, { question: 'ab' })).toBe(false);
    expect(ok(ragAskRequestSchema, { question: 'a'.repeat(501) })).toBe(false);
    expect(ok(ragAskRequestSchema, {})).toBe(false);
    expect(ok(ragAskRequestSchema, { question: 'abc', productId: 'p' })).toBe(false);
  });

  it('W02 B-7: every S47 stream event name parses with its payload', () => {
    const events = [
      {
        event: 'sources',
        mode: 'hybrid',
        items: [{ n: 1, chunkId: 'c1', documentId: 'd1', title: 'Manual', headingPath: ['Setup', 'USB'], page: null }],
      },
      { event: 'text', t: 'Yes, ' },
      { event: 'done', citations: [{ text: 'Yes [1]', sources: [1] }], grounded: true },
      { event: 'not_found', message: 'No answer in the product documents.' },
      { event: 'refusal', category: 'self_harm', source: 'moderation' },
      { event: 'refusal', category: 'x' },
      { event: 'error', code: 'TIMEOUT' },
    ];
    for (const e of events) expect(ok(ragStreamEventSchema, e)).toBe(true);
  });

  it('W02 B-7: stream negatives: unknown event, wrong error code, missing sources mode, text without t', () => {
    expect(ok(ragStreamEventSchema, { event: 'meta', messageId: 'm' })).toBe(false);
    expect(ok(ragStreamEventSchema, { event: 'error', code: 'BOOM' })).toBe(false);
    expect(ok(ragStreamEventSchema, { event: 'sources', items: [] })).toBe(false);
    expect(ok(ragStreamEventSchema, { event: 'text' })).toBe(false);
    expect(ok(ragStreamEventSchema, { event: 'done', grounded: true })).toBe(false);
    expect(ok(ragStreamEventSchema, { event: 'refusal', category: 'x', source: 'other' })).toBe(false);
  });
});
