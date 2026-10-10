import {
  formatRateLimit,
  formatRateLimitPolicy,
  formatRetryAfter,
  headersFor,
} from './rate-limit-headers';

describe('S50 rate limit headers', () => {
  it.each([
    [0, 1],
    [1, 1],
    [999, 1],
    [1000, 1],
    [1001, 2],
    [5000, 5],
    [12_345, 13],
  ])('S50 AS-82: Retry-After for %p ms is %p', (ms, seconds) => {
    expect(formatRetryAfter(ms)).toBe(String(seconds));
  });

  it.each([
    ['a.b', 5, 900_000, '"a.b";q=5;w=900'],
    ['a.b', 14, 1_000, '"a.b";q=14;w=1'],
    ['a.b', 20, 60_000, '"a.b";q=20;w=60'],
    ['a.b', 40, 20_400, '"a.b";q=40;w=20'],
    ['a"b\\c', 1, 1_000, '"a\\"b\\\\c";q=1;w=1'],
  ])('S50 AS-82: RateLimit-Policy item %p/%p/%p', (name, limit, win, out) => {
    expect(formatRateLimitPolicy(name, limit, win)).toBe(out);
  });

  it.each([
    ['a.b', 3.9, 1_001, '"a.b";r=3;t=2'],
    ['a.b', -1, 0, '"a.b";r=0;t=0'],
    ['a.b', 0, 12_000, '"a.b";r=0;t=12'],
    ['a.b', 0.2, 1, '"a.b";r=0;t=1'],
  ])('S50 AS-82: RateLimit item %p/%p/%p', (name, remaining, reset, out) => {
    expect(formatRateLimit(name, remaining, reset)).toBe(out);
  });

  it('S50 AS-82: items are joined with ", " in declaration order', () => {
    const h = headersFor([
      {
        name: 'a.one',
        limit: 5,
        windowMs: 60_000,
        remaining: 4,
        resetMs: 12_000,
      },
      { name: 'a.two', limit: 10, windowMs: 1_000, remaining: 9, resetMs: 100 },
    ]);
    expect(h['RateLimit-Policy']).toBe('"a.one";q=5;w=60, "a.two";q=10;w=1');
    expect(h['RateLimit']).toBe('"a.one";r=4;t=12, "a.two";r=9;t=1');
  });

  it('S50 AS-82: a local-lease decision reports the stored limit and the lease remaining', () => {
    const h = headersFor([
      {
        name: 'a.one',
        limit: 60,
        windowMs: 60_000,
        remaining: 5,
        resetMs: 1_000,
      },
    ]);
    expect(h['RateLimit-Policy']).toBe('"a.one";q=60;w=60');
    expect(h['RateLimit']).toBe('"a.one";r=5;t=1');
  });

  it('S50 AS-82: no items, no headers', () => {
    expect(headersFor([])).toEqual({});
  });
});
