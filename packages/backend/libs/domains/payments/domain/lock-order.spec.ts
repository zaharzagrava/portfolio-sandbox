import * as fc from 'fast-check';
import { aggregateRows, compareRows } from './lock-order';

describe('Lock order', () => {
  it('S14 AS-25: rows are ordered by account id, then shard', () => {
    const rows = aggregateRows([
      { accountId: 'SHOP_b', shard: 0, amountMinor: 5 },
      { accountId: 'PLATFORM_FEES', shard: 7, amountMinor: 50 },
      { accountId: 'PLATFORM_FEES', shard: 2, amountMinor: 1 },
      { accountId: 'MARKETPLACE_CLEARING', shard: 7, amountMinor: -55 },
    ]);
    expect(rows.map((r) => `${r.accountId}#${r.shard}`)).toEqual([
      'MARKETPLACE_CLEARING#7',
      'PLATFORM_FEES#2',
      'PLATFORM_FEES#7',
      'SHOP_b#0',
    ]);
  });

  it('S14 AS-25: lines of one row are added together', () => {
    const rows = aggregateRows([
      { accountId: 'A', shard: 0, amountMinor: 5 },
      { accountId: 'B', shard: 0, amountMinor: -9 },
      { accountId: 'A', shard: 0, amountMinor: 4 },
    ]);
    expect(rows).toEqual([
      { accountId: 'A', shard: 0, amountMinor: 9 },
      { accountId: 'B', shard: 0, amountMinor: -9 },
    ]);
  });

  it('S14 AS-25: the order does not depend on the order of the lines (property)', () => {
    const line = fc.record({
      accountId: fc.constantFrom('A', 'B', 'PLATFORM_FEES', 'SHOP_x', 'SHOP_y'),
      shard: fc.integer({ min: 0, max: 31 }),
      amountMinor: fc.integer({ min: -1000, max: 1000 }).filter((n) => n !== 0),
    });
    fc.assert(
      fc.property(
        fc.array(line, { minLength: 2, maxLength: 30 }),
        fc.integer(),
        (lines, seed) => {
          const shuffled = [...lines].sort(
            (a, b) => ((a.shard * 31 + seed) % 7) - ((b.shard * 31 + seed) % 7),
          );
          return (
            JSON.stringify(aggregateRows(lines)) ===
            JSON.stringify(aggregateRows(shuffled))
          );
        },
      ),
    );
  });

  it('S14 AS-25: compareRows is a total order that never returns 0 for distinct rows', () => {
    expect(
      compareRows({ accountId: 'A', shard: 1 }, { accountId: 'A', shard: 2 }),
    ).toBeLessThan(0);
    expect(
      compareRows({ accountId: 'B', shard: 0 }, { accountId: 'A', shard: 9 }),
    ).toBeGreaterThan(0);
    expect(
      compareRows({ accountId: 'A', shard: 1 }, { accountId: 'A', shard: 1 }),
    ).toBe(0);
  });
});
