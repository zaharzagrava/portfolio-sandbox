import {
  assertRegistryValid,
  brownoutEnd,
  DeprecationEntry,
  matchRoute,
  deprecationHeaders,
  evaluateWindow,
  httpDate,
  MIN_WINDOW_DAYS,
} from './deprecation';
import { DEPRECATED_ROUTES, VERSION_REGISTRY } from './version-registry';

const entry: DeprecationEntry = {
  deprecatedAt: '2026-10-01T00:00:00Z',
  sunset: '2027-04-01T00:00:00Z',
  replacement: '/v1/stock/{productId}',
  brownouts: [{ from: '2027-02-01T10:00:00Z', to: '2027-02-01T12:00:00Z' }],
};

describe('S42 deprecation (FR-030…FR-032)', () => {
  it('formats the sunset as an IMF-fixdate in UTC', () => {
    expect(httpDate(new Date('2027-04-01T00:00:00Z'))).toBe(
      'Thu, 01 Apr 2027 00:00:00 GMT',
    );
  });

  it('builds the three headers', () => {
    const h = deprecationHeaders(entry);
    expect(h.Deprecation).toBe(`@${Date.parse('2026-10-01T00:00:00Z') / 1000}`);
    expect(h.Sunset).toBe('Thu, 01 Apr 2027 00:00:00 GMT');
    expect(h.Link).toContain('rel="deprecation"');
    expect(h.Link).toContain('type="text/html"');
    expect(h.Link).toContain('rel="successor-version"');
    expect(h.Link).toContain('/v1/stock/{productId}');
  });

  it('S42 AS-32: the headers of the deprecated stock route are exactly the documented ones', () => {
    const h = deprecationHeaders(
      DEPRECATED_ROUTES['GET /v1/products/:id/stock'],
    );
    expect(h).toEqual({
      Deprecation: '@1790812800',
      Sunset: 'Thu, 01 Apr 2027 00:00:00 GMT',
      Link: '<https://docs.marketplace.dev/api/deprecations>; rel="deprecation"; type="text/html", </v1/stock/{productId}>; rel="successor-version"',
    });
  });

  it.each<[string, string, string]>([
    ['before deprecation', '2026-09-30T23:59:59Z', 'live'],
    ['deprecated, serving', '2026-12-01T00:00:00Z', 'deprecated'],
    ['brownout start inclusive', '2027-02-01T10:00:00Z', 'brownout'],
    ['inside brownout', '2027-02-01T11:00:00Z', 'brownout'],
    ['brownout end exclusive', '2027-02-01T12:00:00Z', 'deprecated'],
    ['one second before sunset', '2027-03-31T23:59:59Z', 'deprecated'],
    ['at sunset', '2027-04-01T00:00:00Z', 'retired'],
    ['after sunset', '2027-05-01T00:00:00Z', 'retired'],
  ])('window %s', (_n, now, expected) => {
    expect(evaluateWindow(entry, new Date(now))).toBe(expected);
  });

  it('finds the registry entry of a request by method and path template', () => {
    const registry = { 'GET /v1/products/:id/stock': entry };
    expect(matchRoute('GET', '/v1/products/abc/stock', registry)?.key).toBe(
      'GET /v1/products/:id/stock',
    );
    expect(matchRoute('GET', '/v1/products/abc/stock/', registry)?.key).toBe(
      'GET /v1/products/:id/stock',
    );
    expect(matchRoute('GET', '/v1/products/abc/stock?x=1', registry)?.key).toBe(
      'GET /v1/products/:id/stock',
    );
    expect(matchRoute('POST', '/v1/products/abc/stock', registry)).toBeNull();
    expect(matchRoute('GET', '/v1/stock/abc', registry)).toBeNull();
    expect(matchRoute('GET', '/v1/products/a/b/stock', registry)).toBeNull();
    expect(matchRoute('HEAD', '/v1/products/abc/stock', registry)?.key).toBe(
      'GET /v1/products/:id/stock',
    );
  });

  it('the seconds to the end of a brownout window', () => {
    expect(
      brownoutEnd(entry, new Date('2027-02-01T10:30:00Z'))?.toISOString(),
    ).toBe('2027-02-01T12:00:00.000Z');
    expect(
      brownoutEnd(entry, new Date('2027-02-01T12:00:00Z')),
    ).toBeUndefined();
  });

  it('refuses a registry whose sunset is less than 6 months after deprecation', () => {
    expect(MIN_WINDOW_DAYS).toBeGreaterThanOrEqual(180);
    const bad = { ...entry, sunset: '2026-12-01T00:00:00Z' };
    expect(() => assertRegistryValid({ 'GET /x': bad })).toThrow(/6 months/);
  });

  it('allows a security removal with an explicit flag and at least 30 days', () => {
    const ok = { ...entry, sunset: '2026-11-15T00:00:00Z', security: true };
    expect(() => assertRegistryValid({ 'GET /x': ok })).not.toThrow();
    const tooShort = {
      ...entry,
      sunset: '2026-10-20T00:00:00Z',
      security: true,
    };
    expect(() => assertRegistryValid({ 'GET /x': tooShort })).toThrow(
      /30 days/,
    );
  });

  it('the shipped registry is valid and lists the deprecated route and version 2026-01-15', () => {
    expect(() => assertRegistryValid(DEPRECATED_ROUTES)).not.toThrow();
    expect(DEPRECATED_ROUTES['GET /v1/products/:id/stock'].sunset).toBe(
      '2027-04-01T00:00:00Z',
    );
    const old = VERSION_REGISTRY.find((v) => v.version === '2026-01-15')!;
    expect(old.lifecycle).toMatchObject({
      status: 'deprecated',
      sunset: '2027-04-01T00:00:00Z',
    });
  });
});
