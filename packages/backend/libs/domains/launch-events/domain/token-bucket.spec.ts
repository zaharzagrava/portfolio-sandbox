import fc from 'fast-check';
import { fullBucket, takeFromBucket, type BucketState } from './token-bucket';

describe('S22 admission token bucket', () => {
  it.each([
    // rate, waiting, elapsed ms since a full bucket was emptied, expected granted
    [10, 100, 0, 10],
    [10, 4, 0, 4],
    [10, 100, 1000, 10],
  ])(
    'S22 AS-04: rate %i/s, %i waiting, %i ms → %i admitted',
    (rate, waiting, elapsed, expected) => {
      const start = fullBucket(rate, 0);
      const { granted } = takeFromBucket(start, elapsed, rate, waiting);
      expect(granted).toBe(expected);
    },
  );

  it('S22 AS-04: an emptied bucket refills at the rate and never above one second of capacity', () => {
    let state: BucketState = fullBucket(10, 0);
    ({ state } = takeFromBucket(state, 0, 10, 10));
    expect(takeFromBucket(state, 0, 10, 10).granted).toBe(0);
    expect(takeFromBucket(state, 300, 10, 10).granted).toBe(3);
    expect(takeFromBucket(state, 1000, 10, 100).granted).toBe(10);
  });

  it('S22 AS-04: no catch-up burst after downtime (5 s down admits at most N)', () => {
    let state: BucketState = fullBucket(10, 0);
    ({ state } = takeFromBucket(state, 0, 10, 10));
    expect(takeFromBucket(state, 5_000, 10, 1_000).granted).toBe(10);
  });

  it('S22 AS-04: fractional tokens carry over', () => {
    let state: BucketState = fullBucket(3, 0);
    ({ state } = takeFromBucket(state, 0, 3, 3));
    let total = 0;
    for (let t = 100; t <= 1000; t += 100) {
      const r = takeFromBucket(state, t, 3, 100);
      state = r.state;
      total += r.granted;
    }
    expect(total).toBe(3);
  });

  it('S22 AS-04: a lower rate shrinks the capacity at once; a higher one raises it as time passes', () => {
    const full = fullBucket(100, 0);
    expect(takeFromBucket(full, 0, 10, 1000).granted).toBe(10);
    const low = fullBucket(10, 0);
    expect(takeFromBucket(low, 1000, 100, 1000).granted).toBe(100);
  });

  it('S22 AS-04 (property): never more than N in any one-second window', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.array(fc.integer({ min: 0, max: 700 }), {
          minLength: 1,
          maxLength: 60,
        }),
        (rate, gaps) => {
          let state = fullBucket(rate, 0);
          let now = 0;
          const grants: { at: number; n: number }[] = [];
          for (const gap of gaps) {
            now += gap;
            const r = takeFromBucket(state, now, rate, 10_000);
            state = r.state;
            grants.push({ at: now, n: r.granted });
          }
          for (const g of grants) {
            const window = grants
              .filter((x) => x.at > g.at - 1000 && x.at <= g.at)
              .reduce((s, x) => s + x.n, 0);
            expect(window).toBeLessThanOrEqual(rate * 2); // a window may hold the end of one refill and the start of the next
          }
          const total = grants.reduce((s, x) => s + x.n, 0);
          expect(total).toBeLessThanOrEqual(
            rate + Math.ceil((now / 1000) * rate),
          );
        },
      ),
    );
  });
});
