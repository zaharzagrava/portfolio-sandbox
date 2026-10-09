import { MetricsRegistry } from './metrics-registry';

const register = (type: 'counter' | 'histogram', name: string) =>
  type === 'counter'
    ? MetricsRegistry.counter({ name, help: 'h', labels: [] })
    : MetricsRegistry.histogram({ name, help: 'h', labels: [], buckets: [1] });

describe('MetricsRegistry (U-MET)', () => {
  beforeEach(() => MetricsRegistry.reset());

  it.each([
    'userId',
    'shopId',
    'requestId',
    'email',
    'ip',
    'url',
    'path',
    'user_id',
    'REQUEST_ID',
  ])(
    'S54 AS-149: a metric with the forbidden label %s fails registration naming the metric and the label',
    (label) => {
      expect(() =>
        MetricsRegistry.counter({
          name: 'orders_created_total',
          help: 'h',
          labels: [label],
        }),
      ).toThrow(new RegExp(`orders_created_total.*${label}`));
    },
  );

  it('S54 AS-149: two registrations of one name with a different type or different labels fail', () => {
    MetricsRegistry.counter({
      name: 'jobs_done_total',
      help: 'h',
      labels: ['kind'],
    });
    expect(() =>
      MetricsRegistry.counter({
        name: 'jobs_done_total',
        help: 'h',
        labels: ['kind', 'result'],
      }),
    ).toThrow(/jobs_done_total/);
    expect(() =>
      MetricsRegistry.gauge({
        name: 'jobs_done_total',
        help: 'h',
        labels: ['kind'],
      }),
    ).toThrow(/jobs_done_total/);
  });

  it('S54 AS-149: identical registrations share one instrument', () => {
    const a = MetricsRegistry.counter({
      name: 'jobs_done_total',
      help: 'h',
      labels: ['kind'],
    });
    const b = MetricsRegistry.counter({
      name: 'jobs_done_total',
      help: 'h',
      labels: ['kind'],
    });
    a.add(1, { kind: 'x' });
    b.add(2, { kind: 'x' });
    expect(MetricsRegistry.value('jobs_done_total', { kind: 'x' })).toBe(3);
  });

  it.each([
    ['CamelCase_total', 'counter'],
    ['has-dash_total', 'counter'],
    ['9starts_with_digit_total', 'counter'],
    ['requests_shed', 'counter'],
    ['request_latency', 'histogram'],
    ['request_latency_millis', 'histogram'],
  ] as const)('S54 AS-149: the name %s is rejected for a %s', (name, type) => {
    expect(() => register(type, name)).toThrow(name);
  });

  it.each([
    ['requests_shed_total', 'counter'],
    ['request_duration_seconds', 'histogram'],
    ['payload_size_bytes', 'histogram'],
    ['cache_hit_ratio', 'histogram'],
  ] as const)('S54 AS-149: the name %s is accepted for a %s', (name, type) => {
    expect(() => register(type, name)).not.toThrow();
  });

  it('S54 AS-149: gauges may be named for what they count', () => {
    const g = MetricsRegistry.gauge({
      name: 'jobs_queued',
      help: 'h',
      labels: ['kind'],
    });
    g.set(7, { kind: 'a' });
    g.set(5, { kind: 'a' });
    expect(MetricsRegistry.value('jobs_queued', { kind: 'a' })).toBe(5);
  });

  it('S54 AS-149: histograms keep count and sum', () => {
    const h = MetricsRegistry.histogram({
      name: 'work_duration_seconds',
      help: 'h',
      labels: [],
      buckets: [0.1, 1],
    });
    h.record(0.5);
    h.record(1.5);
    expect(MetricsRegistry.histogramValue('work_duration_seconds')).toEqual({
      count: 2,
      sum: 2,
    });
  });

  it('S54 AS-150: label sets beyond 2 000 per metric fall into one overflow series', () => {
    const c = MetricsRegistry.counter({
      name: 'by_thing_total',
      help: 'h',
      labels: ['thing'],
    });
    for (let i = 0; i < 2_100; i++) c.add(1, { thing: `t${i}` });
    expect(MetricsRegistry.seriesCount('by_thing_total')).toBe(2_001);
    expect(MetricsRegistry.value('by_thing_total', { overflow: 'true' })).toBe(
      100,
    );
  });
});
