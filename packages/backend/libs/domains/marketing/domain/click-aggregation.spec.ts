import fc from 'fast-check';
import {
  aggregateBatch,
  isLate,
  type AggregationInput,
} from './click-aggregation';

/** A deterministic permutation (Fisher-Yates over a small LCG), so a failing case replays from its seed. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const rec = (
  click: string,
  campaign: string,
  receivedAt: string,
  valid: 0 | 1 = 1,
): AggregationInput => ({
  click_id: click,
  campaign_id: campaign,
  received_at: receivedAt,
  valid,
});

describe('S36 AS-42: batch aggregation (pure)', () => {
  it('groups by campaign and minute of received_at, valid counted apart from invalid, tagged with the batch identity', () => {
    expect(
      aggregateBatch(2, 500, [
        rec('c1', 'a', '2026-10-01 10:00:05.000'),
        rec('c2', 'a', '2026-10-01 10:00:59.999', 0),
        rec('c3', 'a', '2026-10-01 10:01:00.000'),
        rec('c4', 'b', '2026-10-01 10:00:01.000'),
      ]),
    ).toEqual([
      {
        campaign_id: 'a',
        minute: '2026-10-01 10:00:00',
        source_partition: 2,
        first_offset: 500,
        clicks: 1,
        invalid: 1,
      },
      {
        campaign_id: 'a',
        minute: '2026-10-01 10:01:00',
        source_partition: 2,
        first_offset: 500,
        clicks: 1,
        invalid: 0,
      },
      {
        campaign_id: 'b',
        minute: '2026-10-01 10:00:00',
        source_partition: 2,
        first_offset: 500,
        clicks: 1,
        invalid: 0,
      },
    ]);
  });

  it('a click id twice in the batch counts once, with the verdict of its first record', () => {
    const rows = aggregateBatch(0, 0, [
      rec('same', 'a', '2026-10-01 10:00:05.000', 1),
      rec('same', 'a', '2026-10-01 10:00:07.000', 0),
      rec('same', 'a', '2026-10-01 10:00:05.000', 1),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clicks: 1, invalid: 0 });
  });

  it('an empty batch gives no rows', () => {
    expect(aggregateBatch(0, 0, [])).toEqual([]);
  });

  it('a late click keeps its own minute: lateness is measured, never moved', () => {
    const now = Date.parse('2026-10-01T10:30:00.000Z');
    expect(isLate('2026-10-01 10:27:59.999', now)).toBe(true);
    expect(isLate('2026-10-01 10:28:00.000', now)).toBe(false);
    expect(isLate('2026-10-01 10:29:30.000', now)).toBe(false);
    const [row] = aggregateBatch(0, 0, [
      rec('c1', 'a', '2026-10-01 09:12:30.000'),
    ]);
    expect(row.minute).toBe('2026-10-01 09:12:00');
  });

  const record = fc.record({
    click_id: fc.constantFrom('c1', 'c2', 'c3', 'c4', 'c5', 'c6'),
    campaign_id: fc.constantFrom('a', 'b'),
    received_at: fc.constantFrom(
      '2026-10-01 10:00:05.000',
      '2026-10-01 10:00:50.000',
      '2026-10-01 10:01:05.000',
      '2026-10-01 10:02:30.000',
    ),
    valid: fc.constantFrom<0 | 1>(0, 1),
  });

  it('property: independent of record order, and valid + invalid equals the distinct click ids', () => {
    fc.assert(
      fc.property(
        fc.array(record, { maxLength: 40 }),
        fc.integer(),
        (records, seed) => {
          const rows = aggregateBatch(3, 77, records);
          expect(aggregateBatch(3, 77, shuffle(records, seed))).toEqual(rows);
          const total = rows.reduce((n, r) => n + r.clicks + r.invalid, 0);
          expect(total).toBe(new Set(records.map((r) => r.click_id)).size);
          for (const r of rows) {
            expect(r.source_partition).toBe(3);
            expect(r.first_offset).toBe(77);
          }
        },
      ),
      { seed: 36, numRuns: 300 },
    );
  });
});
