import {
  trendingQuerySchema,
  trendingResponseSchema,
  storedAnalyticsEventSchema,
} from '@marketplace-sandbox/contracts';

const ok = (
  s: { safeParse: (v: unknown) => { success: boolean } },
  v: unknown,
) => s.safeParse(v).success;

describe('S35 trending contracts', () => {
  it('S35 AS-04: category is 1-40 of [a-z0-9-] and defaults to all', () => {
    expect(trendingQuerySchema.parse({}).category).toBe('all');
    expect(trendingQuerySchema.parse({ category: 'audio-2' }).category).toBe(
      'audio-2',
    );
    expect(ok(trendingQuerySchema, { category: 'a'.repeat(40) })).toBe(true);
    for (const bad of [
      '',
      'a'.repeat(41),
      'Audio',
      'a b',
      'a:b',
      '{x}',
      'a*',
      'é',
    ])
      expect(ok(trendingQuerySchema, { category: bad })).toBe(false);
  });

  it('S35 AS-03: limit is an integer 1-20 and defaults to 20', () => {
    expect(trendingQuerySchema.parse({}).limit).toBe(20);
    expect(trendingQuerySchema.parse({ limit: '1' }).limit).toBe(1);
    expect(trendingQuerySchema.parse({ limit: '20' }).limit).toBe(20);
    for (const bad of ['2.5', '', 'abc', '0', '21', '-1', ' 5'])
      expect(ok(trendingQuerySchema, { limit: bad })).toBe(false);
  });

  it('S35 AS-04: an unknown parameter is rejected', () => {
    expect(ok(trendingQuerySchema, { foo: '1' })).toBe(false);
  });

  it('S35 AS-01: the response envelope parses and money is integer', () => {
    const body = {
      category: 'audio',
      windowMinutes: 60,
      generatedAt: '2026-10-10T12:07:10.000Z',
      items: [
        {
          rank: 1,
          productId: '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b',
          title: 'Headphones B',
          priceMinor: 1999,
          currency: 'EUR',
          category: 'audio',
          score: 35,
        },
      ],
    };
    expect(ok(trendingResponseSchema, body)).toBe(true);
    expect(ok(trendingResponseSchema, { ...body, windowMinutes: 30 })).toBe(
      false,
    );
    expect(
      ok(trendingResponseSchema, {
        ...body,
        items: [{ ...body.items[0], priceMinor: 19.99 }],
      }),
    ).toBe(false);
    expect(
      ok(trendingResponseSchema, {
        ...body,
        items: [{ ...body.items[0], rank: 0 }],
      }),
    ).toBe(false);
  });

  it('S35 AS-30: the stored analytics event shape is validated', () => {
    const event = {
      event_id: '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b',
      name: 'product_view',
      anonymous_id: 'anon-12345678',
      user_id: '',
      ts: '2026-10-10 12:00:30.000',
      received_at: '2026-10-10 12:00:31.250',
      props: { product_id: '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b' },
    };
    expect(ok(storedAnalyticsEventSchema, event)).toBe(true);
    expect(
      ok(storedAnalyticsEventSchema, { ...event, ts: '2026-10-10T12:00:30Z' }),
    ).toBe(false);
    expect(
      ok(storedAnalyticsEventSchema, { ...event, event_id: undefined }),
    ).toBe(false);
    expect(ok(storedAnalyticsEventSchema, { ...event, name: 'nope' })).toBe(
      false,
    );
    expect(
      ok(storedAnalyticsEventSchema, { ...event, anonymous_id: 'short' }),
    ).toBe(false);
  });
});
