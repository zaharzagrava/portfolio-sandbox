import {
  BFF_SECTION_CODES,
  BFF_SECTIONS,
  graphqlErrorCodeSchema,
  mfaRequiredResponseSchema,
  pageQuerySchema,
  productPageResponseSchema,
  sectionErrorSchema,
  sessionLoginRequestSchema,
  sessionMfaRequestSchema,
  sessionResponseSchema,
} from '@marketplace-sandbox/contracts';

const ok = (
  s: { safeParse: (v: unknown) => { success: boolean } },
  v: unknown,
) => s.safeParse(v).success;

const productId = '7b0f6c1e-0d52-4d6f-9d0a-2f6b3f1d5a11';
const product = {
  id: productId,
  shopId: '3f1c6a56-6b66-4a5c-8d8c-0a8a6a0b8a11',
  title: 'Headphones',
  description: 'Over-ear',
  brand: 'Acme',
  category: 'audio',
  priceMinor: 4900,
  currency: 'USD',
  inStock: true,
  rating: 4.5,
  tags: [],
  version: 1,
  viewCount: 0,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('S48 BFF contracts', () => {
  it('S48 C1: the section code enum is exactly the closed set', () => {
    expect([...BFF_SECTION_CODES]).toEqual([
      'UPSTREAM_TIMEOUT',
      'UPSTREAM_UNAVAILABLE',
      'UPSTREAM_NOT_FOUND',
      'UPSTREAM_RATE_LIMITED',
      'UPSTREAM_INVALID',
      'UPSTREAM_OVERLOADED',
      'CIRCUIT_OPEN',
      'BUDGET_EXCEEDED',
    ]);
    expect(
      ok(sectionErrorSchema, {
        section: 'flags',
        code: 'UPSTREAM_TIMEOUT',
        retryable: true,
      }),
    ).toBe(true);
    for (const bad of [
      { section: 'flags', code: 'OOPS', retryable: true },
      { section: 'nope', code: 'CIRCUIT_OPEN', retryable: true },
      { section: 'flags', code: 'CIRCUIT_OPEN', retryable: true, message: 'x' },
      { section: 'flags', code: 'CIRCUIT_OPEN' },
    ])
      expect(ok(sectionErrorSchema, bad)).toBe(false);
  });

  it('S48 C1: the page has the product plus ten nullable sections and an errors array', () => {
    expect(BFF_SECTIONS).toHaveLength(11);
    const page = {
      product,
      shop: null,
      recommendations: null,
      trending: null,
      flags: null,
      chatUnread: null,
      discussions: null,
      videos: null,
      pickup: null,
      flashSale: null,
      auction: null,
      errors: [],
    };
    expect(ok(productPageResponseSchema, page)).toBe(true);
    expect(ok(productPageResponseSchema, { ...page, product: null })).toBe(
      false,
    );
    const { errors: _e, ...noErrors } = page;
    expect(ok(productPageResponseSchema, noErrors)).toBe(false);
    expect(ok(productPageResponseSchema, { ...page, extra: 1 })).toBe(false);
    expect(
      ok(productPageResponseSchema, {
        ...page,
        shop: { id: product.shopId, name: 'S', slug: 's' },
      }),
    ).toBe(true);
  });

  it.each([
    [{}, true],
    [{ lat: '50.45', lng: '30.52' }, true],
    [{ lat: '50.45', lng: '30.52', radiusKm: '10' }, true],
    [{ lat: '91', lng: '30' }, false],
    [{ lat: '-91', lng: '30' }, false],
    [{ lat: '50', lng: '181' }, false],
    [{ lat: '50' }, false],
    [{ lng: '30' }, false],
    [{ radiusKm: '0', lat: '1', lng: '1' }, false],
    [{ radiusKm: '101', lat: '1', lng: '1' }, false],
    [{ radiusKm: '100', lat: '1', lng: '1' }, true],
    [{ lat: 'x', lng: '1' }, false],
    [{ other: '1' }, false],
  ])('S48 AS-05: page query %j valid=%s', (q, valid) => {
    expect(ok(pageQuerySchema, q)).toBe(valid);
  });

  it('S48 AS-05: radiusKm defaults to 10', () => {
    expect(pageQuerySchema.parse({ lat: '1', lng: '2' }).radiusKm).toBe(10);
  });

  it('S48 AS-43: session request and response shapes are strict and carry no token', () => {
    expect(
      ok(sessionLoginRequestSchema, { email: 'a@b.co', password: 'x' }),
    ).toBe(true);
    for (const bad of [
      { email: 'a@b.co' },
      { password: 'x' },
      { email: 'a@b.co', password: 'x', extra: 1 },
      { email: 'not-an-email', password: 'x' },
      { email: 'a@b.co', password: '' },
    ])
      expect(ok(sessionLoginRequestSchema, bad)).toBe(false);
    expect(ok(sessionMfaRequestSchema, { code: '123456' })).toBe(true);
    expect(ok(sessionMfaRequestSchema, { code: '' })).toBe(false);
    expect(ok(sessionMfaRequestSchema, { code: '1', x: 1 })).toBe(false);
    const session = {
      user: { id: 'u1', email: 'a@b.co', role: 'USER' },
      expiresAt: '2026-01-01T00:00:00.000Z',
    };
    expect(ok(sessionResponseSchema, session)).toBe(true);
    expect(ok(sessionResponseSchema, { ...session, accessToken: 'x' })).toBe(
      false,
    );
    expect(ok(mfaRequiredResponseSchema, { mfaRequired: true })).toBe(true);
    expect(
      ok(mfaRequiredResponseSchema, { mfaRequired: true, mfaToken: 't' }),
    ).toBe(false);
  });

  it('S48 AS-31: GraphQL error codes include the limit and request codes', () => {
    for (const code of [
      'QUERY_TOO_DEEP',
      'QUERY_TOO_COSTLY',
      'TOO_MANY_ROOT_FIELDS',
      'BAD_USER_INPUT',
      'BUDGET_EXCEEDED',
      'INTROSPECTION_DISABLED',
      'PERSISTED_QUERY_NOT_FOUND',
      'UPSTREAM_TIMEOUT',
      'CIRCUIT_OPEN',
    ])
      expect(ok(graphqlErrorCodeSchema, code)).toBe(true);
    expect(ok(graphqlErrorCodeSchema, 'SOMETHING')).toBe(false);
  });
});
