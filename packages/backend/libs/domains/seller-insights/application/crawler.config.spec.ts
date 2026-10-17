import { CrawlerConfigError, parseCrawlerConfig } from './crawler.config';

const run = (values: Record<string, unknown>, production = false) =>
  parseCrawlerConfig(values, { production });

describe('S41 AS-56: crawler configuration', () => {
  it('an empty configuration takes the defaults', () => {
    expect(run({})).toEqual({
      fetchLoops: 16,
      minGapMs: 1_000,
      maxBodyBytes: 2 * 1024 * 1024,
      scheduleCap: 5_000,
      leaseMs: 60_000,
      fixtureHosts: [],
    });
  });

  it('valid values are taken as given', () => {
    expect(
      run({
        crawler_fetch_loops: 64,
        crawler_min_gap_ms: 2_500,
        crawler_max_body_bytes: 8 * 1024 * 1024,
        crawler_schedule_cap: 2,
        crawler_lease_ms: 30_000,
        crawler_fixture_hosts: 'rival.test, other.test',
      }),
    ).toEqual({
      fetchLoops: 64,
      minGapMs: 2_500,
      maxBodyBytes: 8 * 1024 * 1024,
      scheduleCap: 2,
      leaseMs: 30_000,
      fixtureHosts: ['rival.test', 'other.test'],
    });
  });

  it.each([
    [
      'fetch loops below 1',
      { crawler_fetch_loops: 0 },
      false,
      'crawler_fetch_loops',
    ],
    [
      'fetch loops above 64',
      { crawler_fetch_loops: 65 },
      false,
      'crawler_fetch_loops',
    ],
    [
      'a politeness minimum below 1 s',
      { crawler_min_gap_ms: 999 },
      false,
      'crawler_min_gap_ms',
    ],
    [
      'a body cap above 8 MiB',
      { crawler_max_body_bytes: 8 * 1024 * 1024 + 1 },
      false,
      'crawler_max_body_bytes',
    ],
    [
      'a scheduler cap of 0',
      { crawler_schedule_cap: 0 },
      false,
      'crawler_schedule_cap',
    ],
    ['a lease of 1 s', { crawler_lease_ms: 1_000 }, false, 'crawler_lease_ms'],
    [
      'a non numeric value',
      { crawler_fetch_loops: 'many' },
      false,
      'crawler_fetch_loops',
    ],
    [
      'the fixture allowlist in production',
      { crawler_fixture_hosts: 'rival.test' },
      true,
      'crawler_fixture_hosts',
    ],
  ])('%s fails naming the key', (_name, values, production, key) => {
    expect(() => run(values, production)).toThrow(CrawlerConfigError);
    expect(() => run(values, production)).toThrow(key);
  });

  it('the fixture allowlist is honoured outside production only', () => {
    expect(
      run({ crawler_fixture_hosts: 'rival.test' }, false).fixtureHosts,
    ).toEqual(['rival.test']);
    expect(run({ crawler_fixture_hosts: '' }, true).fixtureHosts).toEqual([]);
  });
});
