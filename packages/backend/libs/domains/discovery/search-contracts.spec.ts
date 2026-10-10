import {
  productSearchQuerySchema,
  shopProductSearchQuerySchema,
  searchClickRequestSchema,
  searchQualityQuerySchema,
  synonymsPutRequestSchema,
  searchEventSchemas,
} from '@marketplace-sandbox/contracts';

const ok = (s: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  s.safeParse(v).success;

describe('S32 search contracts', () => {
  it('S32 AS-10: query booleans accept only true|false', () => {
    expect(productSearchQuerySchema.parse({ inStock: 'true' }).inStock).toBe(true);
    for (const bad of ['1', 'TRUE', '', 'yes']) {
      expect(ok(productSearchQuerySchema, { inStock: bad })).toBe(false);
      expect(ok(productSearchQuerySchema, { facets: bad })).toBe(false);
      expect(ok(productSearchQuerySchema, { semantic: bad })).toBe(false);
    }
  });

  it('S32 AS-10: numbers are digit strings only and limit defaults to 20', () => {
    expect(productSearchQuerySchema.parse({}).limit).toBe(20);
    expect(productSearchQuerySchema.parse({ minPriceMinor: '500' }).minPriceMinor).toBe(500);
    for (const bad of ['1e3', '', ' 5', '-1', '5.5']) {
      expect(ok(productSearchQuerySchema, { minPriceMinor: bad })).toBe(false);
    }
    expect(ok(productSearchQuerySchema, { limit: '0' })).toBe(false);
    expect(ok(productSearchQuerySchema, { limit: '51' })).toBe(false);
    expect(ok(productSearchQuerySchema, { minRating: '5' })).toBe(true);
    expect(ok(productSearchQuerySchema, { minRating: '6' })).toBe(false);
  });

  it('S32 AS-10: unknown keys and bad sort are rejected', () => {
    expect(ok(productSearchQuerySchema, { size: '5' })).toBe(false);
    expect(ok(productSearchQuerySchema, { sort: 'popular' })).toBe(false);
  });

  it('S32 AS-30: shop search requires q and defaults limit to 25', () => {
    expect(ok(shopProductSearchQuerySchema, {})).toBe(false);
    expect(shopProductSearchQuerySchema.parse({ q: 'a' }).limit).toBe(25);
    expect(ok(shopProductSearchQuerySchema, { q: 'a', status: 'DELETED' })).toBe(false);
  });

  it('S32 AS-73: quality params are not clamped', () => {
    expect(searchQualityQuerySchema.parse({})).toEqual({ days: 7, limit: 50 });
    for (const days of ['0', '91', 'abc']) {
      expect(ok(searchQualityQuerySchema, { days })).toBe(false);
    }
    expect(ok(searchQualityQuerySchema, { limit: '101' })).toBe(false);
  });

  it('S32 AS-01: click and synonyms bodies are strict', () => {
    const productId = '0b8f7a52-6c58-4f0e-9a43-0d3d2f6f2a11';
    expect(ok(searchClickRequestSchema, { searchId: 's', productId, position: 99 })).toBe(true);
    expect(ok(searchClickRequestSchema, { searchId: 's', productId, position: 100 })).toBe(false);
    expect(ok(searchClickRequestSchema, { searchId: 's', productId: 'x', position: 0 })).toBe(false);
    expect(ok(synonymsPutRequestSchema, { rules: ['a, b'], expectedVersion: 1 })).toBe(true);
    expect(ok(synonymsPutRequestSchema, { rules: [], expectedVersion: 1, extra: 1 })).toBe(false);
  });

  it('S32 AS-76: event envelopes parse and reject wrong version', () => {
    const base = {
      eventId: '0192f3c1-7a2e-7b3c-8d4e-5f6a7b8c9d0e',
      version: 1,
      occurredAt: '2026-10-10T10:00:00.000Z',
      aggregateId: 'sid',
    };
    const performed = {
      ...base,
      type: 'search.performed',
      payload: {
        searchId: 'sid',
        query: 'iphone',
        results: 2,
        mode: 'lexical',
        userHash: 'h',
        filters: ['category'],
        degraded: [],
        surface: 'http',
      },
    };
    expect(ok(searchEventSchemas['search.performed'], performed)).toBe(true);
    expect(ok(searchEventSchemas['search.performed'], { ...performed, version: 2 })).toBe(false);
    expect(
      ok(searchEventSchemas['search.performed'], {
        ...performed,
        payload: { ...performed.payload, surface: 'cli' },
      }),
    ).toBe(false);
  });
});
