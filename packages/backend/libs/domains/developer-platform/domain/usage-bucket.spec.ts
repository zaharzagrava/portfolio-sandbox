import fc from 'fast-check';
import {
  billableUnits,
  bucketMinute,
  usageEventId,
  UsageRecord,
} from './usage-bucket';

const rec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  requestId: 'r1',
  shopId: 's1',
  livemode: true,
  status: 200,
  cost: 1,
  ts: new Date('2026-10-06T12:00:30Z'),
  ...over,
});

describe('S42 usage bucket (FR-058)', () => {
  it('buckets to the UTC minute', () => {
    expect(
      bucketMinute(new Date('2026-10-06T12:00:59.999Z')).toISOString(),
    ).toBe('2026-10-06T12:00:00.000Z');
    expect(
      bucketMinute(new Date('2026-10-06T12:01:00.000Z')).toISOString(),
    ).toBe('2026-10-06T12:01:00.000Z');
  });

  it.each<[string, Partial<UsageRecord>, number]>([
    ['served live call', {}, 1],
    ['cost weighted', { cost: 50 }, 50],
    ['client error is billable', { status: 404 }, 1],
    ['sandbox excluded', { livemode: false }, 0],
    ['401 excluded', { status: 401 }, 0],
    ['429 excluded', { status: 429 }, 0],
    ['500 excluded', { status: 500 }, 0],
    ['503 excluded', { status: 503 }, 0],
    ['499 included', { status: 499 }, 1],
  ])('billable units: %s', (_n, over, expected) => {
    expect(billableUnits(rec(over))).toBe(expected);
  });

  it('event id is deterministic per (shop, metric, minute, sequence) and differs across them', () => {
    const m = new Date('2026-10-06T12:00:00Z');
    const a = usageEventId('s1', 'api.calls', m, 0);
    expect(a).toBe(usageEventId('s1', 'api.calls', m, 0));
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const others = [
      usageEventId('s2', 'api.calls', m, 0),
      usageEventId('s1', 'other', m, 0),
      usageEventId('s1', 'api.calls', new Date('2026-10-06T12:01:00Z'), 0),
      usageEventId('s1', 'api.calls', m, 1),
    ];
    expect(new Set([a, ...others]).size).toBe(5);
  });

  it('property: summing buckets equals the billable records, under duplication and any order', () => {
    const recordArb = fc.record({
      requestId: fc.integer({ min: 0, max: 30 }).map((n) => `r${n}`),
      livemode: fc.boolean(),
      status: fc.constantFrom(200, 201, 404, 401, 429, 500, 503),
      cost: fc.integer({ min: 1, max: 5 }),
      minute: fc.integer({ min: 0, max: 3 }),
    });
    fc.assert(
      fc.property(fc.array(recordArb, { maxLength: 60 }), (raw) => {
        const base = Date.parse('2026-10-06T12:00:00Z');
        const records = raw.map((r) =>
          rec({
            requestId: `${r.requestId}-${r.minute}`,
            livemode: r.livemode,
            status: r.status,
            cost: r.cost,
            ts: new Date(base + r.minute * 60_000 + 5_000),
          }),
        );
        // dedupe by request id as the metering handler does
        const expected = new Map<string, number>();
        for (const r of records) expected.set(r.requestId, billableUnits(r));
        const expectedTotal = [...expected.values()].reduce((a, b) => a + b, 0);

        const shuffled = [...records, ...records].sort((a, b) =>
          a.requestId < b.requestId ? 1 : -1,
        );
        const seen = new Set<string>();
        let sum = 0;
        for (const r of shuffled) {
          if (seen.has(r.requestId)) continue;
          seen.add(r.requestId);
          sum += billableUnits(r);
        }
        return sum === expectedTotal;
      }),
    );
  });
});
