import {
  CRAWL_STATUSES,
  CrawlStatus,
  hostBackoffMs,
  nextIntervalMs,
  parseRetryAfter,
  ScheduleState,
  statusFromHttp,
} from './schedule';

const H = 3_600_000;
const state = (p: Partial<ScheduleState> = {}): ScheduleState => ({
  unchangedStreak: 0,
  errorStreak: 0,
  noPriceStreak: 0,
  ...p,
});
const mid = () => 0.5;

describe('S41 AS-35/37/38/29: re-crawl interval without jitter', () => {
  it.each<[CrawlStatus, Partial<ScheduleState>, number]>([
    ['ok', {}, 6 * H],
    ['unchanged', { unchangedStreak: 1 }, 12 * H],
    ['unchanged', { unchangedStreak: 2 }, 24 * H],
    ['unchanged', { unchangedStreak: 3 }, 48 * H],
    ['unchanged', { unchangedStreak: 4 }, 48 * H],
    ['unchanged', { unchangedStreak: 40 }, 48 * H],
    ['no_price', { noPriceStreak: 1 }, 6 * H],
    ['no_price', { noPriceStreak: 2 }, 6 * H],
    ['no_price', { noPriceStreak: 3 }, 24 * H],
    ['no_price', { noPriceStreak: 9 }, 24 * H],
    ['out_of_stock', { noPriceStreak: 1 }, 6 * H],
    ['out_of_stock', { noPriceStreak: 3 }, 24 * H],
    ['disallowed_by_robots', {}, 24 * H],
    ['robots_unavailable', {}, H],
    ['gone', { errorStreak: 1 }, 12 * H],
    ['gone', { errorStreak: 2 }, 24 * H],
    ['gone', { errorStreak: 3 }, 48 * H],
    ['gone', { errorStreak: 10 }, 48 * H],
    ['blocked_by_site', { errorStreak: 5 }, 24 * H],
    ['http_4xx', { errorStreak: 5 }, 12 * H],
    ['http_5xx', { errorStreak: 1 }, H],
    ['http_5xx', { errorStreak: 2 }, 2 * H],
    ['http_5xx', { errorStreak: 3 }, 4 * H],
    ['http_5xx', { errorStreak: 5 }, 16 * H],
    ['http_5xx', { errorStreak: 6 }, 24 * H],
    ['http_5xx', { errorStreak: 60 }, 24 * H],
    ['network_error', { errorStreak: 2 }, 2 * H],
    ['timeout', { errorStreak: 3 }, 4 * H],
    ['unresolvable', { errorStreak: 4 }, 8 * H],
    ['tls_error', { errorStreak: 8 }, 24 * H],
    ['http_429', { errorStreak: 7 }, 6 * H],
    ['http_503', { errorStreak: 7 }, 6 * H],
    ['blocked_address', {}, 24 * H],
    ['invalid_url', {}, 24 * H],
    ['redirect_refused', {}, 24 * H],
    ['redirected_host', {}, 24 * H],
    ['too_many_redirects', {}, 24 * H],
    ['unsupported_content_type', {}, 24 * H],
    ['http_3xx', {}, 24 * H],
    ['history_unavailable', {}, 15 * 60_000],
  ])('S41 AS-35: %s %j gives %d ms', (status, partial, expected) => {
    expect(nextIntervalMs(status, state(partial), mid)).toBe(expected);
  });

  it('S41 AS-37: a changed page with the same price is a plain ok crawl', () => {
    expect(nextIntervalMs('ok', state({ unchangedStreak: 0 }), mid)).toBe(
      6 * H,
    );
  });

  it('S41 AS-35: every status has a rule', () => {
    for (const status of CRAWL_STATUSES)
      expect(
        nextIntervalMs(status, state({ errorStreak: 1 }), mid),
      ).toBeGreaterThan(0);
    expect(new Set(CRAWL_STATUSES).size).toBe(CRAWL_STATUSES.length);
  });
});

describe('S41 AS-35: jitter and floor', () => {
  it.each([
    [0, 0.9],
    [0.5, 1],
    [0.999999, 1.1],
  ])('S41 AS-35: rand %p scales 6 h by about %p', (r, factor) => {
    const ms = nextIntervalMs('ok', state(), () => r);
    expect(ms).toBeGreaterThanOrEqual(Math.floor(6 * H * factor) - 10);
    expect(ms).toBeLessThanOrEqual(Math.ceil(6 * H * factor) + 10);
  });

  it.each(CRAWL_STATUSES.filter((s) => s !== 'history_unavailable'))(
    'S41 AS-35: %s is never shorter than 1 h',
    (status) => {
      for (const r of [0, 0.25, 0.5, 0.99])
        expect(
          nextIntervalMs(
            status,
            state({ errorStreak: 1, unchangedStreak: 1 }),
            () => r,
          ),
        ).toBeGreaterThanOrEqual(H);
    },
  );

  it('S41 AS-35: the 1 h floor is applied after jitter', () => {
    expect(nextIntervalMs('robots_unavailable', state(), () => 0)).toBe(H);
    expect(nextIntervalMs('http_5xx', state({ errorStreak: 1 }), () => 0)).toBe(
      H,
    );
  });

  it('S41 AS-41: history_unavailable is exempt from the floor and jittered', () => {
    expect(nextIntervalMs('history_unavailable', state(), () => 0)).toBe(
      13.5 * 60_000,
    );
    expect(nextIntervalMs('history_unavailable', state(), () => 0.5)).toBe(
      15 * 60_000,
    );
  });

  it('S41 AS-35: jitter stays within plus or minus 10 percent', () => {
    for (let i = 0; i < 100; i++) {
      const ms = nextIntervalMs(
        'unchanged',
        state({ unchangedStreak: 2 }),
        () => i / 100,
      );
      expect(ms).toBeGreaterThanOrEqual(24 * H * 0.9 - 1);
      expect(ms).toBeLessThanOrEqual(24 * H * 1.1 + 1);
    }
  });
});

describe('S41 AS-24: host back-off', () => {
  it.each([
    [1000, null, 10_000],
    [1000, 5, 10_000],
    [1000, 120, 120_000],
    [1000, 99999, 3_600_000],
    [2000, 120, 120_000],
    [300_000, 120, 3_000_000],
    [1000, 0, 10_000],
    [1000, -5, 10_000],
  ])(
    'S41 AS-24: delay %d retry-after %p gives %d',
    (delay, retry, expected) => {
      expect(hostBackoffMs(delay, retry)).toBe(expected);
    },
  );
});

describe('S41 AS-24: Retry-After parsing', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  it.each([
    ['120', 120],
    [' 7 ', 7],
    ['0', 0],
    ['99999', 99999],
    ['Sat, 17 Oct 2026 12:02:00 GMT', 120],
    ['Sat, 17 Oct 2026 11:00:00 GMT', 0],
    ['-5', null],
    ['1.5', null],
    ['abc', null],
    ['', null],
    ['Not, a date', null],
    ['2026-10-17T12:02:00Z', null],
    [null, null],
    [undefined, null],
  ])('S41 AS-24: %j -> %p', (header, expected) => {
    expect(parseRetryAfter(header, now)).toBe(expected);
  });
});

describe('S41 AS-29: status from HTTP', () => {
  it.each([
    [404, 'gone'],
    [410, 'gone'],
    [401, 'blocked_by_site'],
    [403, 'blocked_by_site'],
    [400, 'http_4xx'],
    [408, 'http_4xx'],
    [451, 'http_4xx'],
    [429, 'http_429'],
    [503, 'http_503'],
    [500, 'http_5xx'],
    [502, 'http_5xx'],
    [504, 'http_5xx'],
    [599, 'http_5xx'],
    [301, 'http_3xx'],
    [302, 'http_3xx'],
    [304, 'http_3xx'],
    [200, 'ok'],
  ])('S41 AS-29: HTTP %d -> %s', (code, expected) => {
    expect(statusFromHttp(code)).toBe(expected);
  });
});
