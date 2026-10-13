import * as fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import { shardOf, shardFor } from './shard';

describe('Shard choice', () => {
  it('S14 AS-23: the same key and shard count always give the same shard', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 256 }), (key, n) => {
        return shardOf(key, n) === shardOf(key, n);
      }),
    );
  });

  it('S14 AS-23: the shard is an integer in 0..N-1 for any N from 1 to 256', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 256 }), (key, n) => {
        const s = shardOf(key, n);
        return Number.isInteger(s) && s >= 0 && s < n;
      }),
    );
  });

  it('S14 AS-23: one shard collapses everything to 0', () => {
    expect(shardOf('anything', 1)).toBe(0);
  });

  it('S14 AS-23: 10 000 references spread within 75% to 125% of the mean over 32 shards', () => {
    const counts = new Array<number>(32).fill(0);
    for (let i = 0; i < 10_000; i++) counts[shardOf(randomUUID(), 32)]++;
    const mean = 10_000 / 32;
    for (const c of counts) {
      expect(c).toBeGreaterThan(mean * 0.75);
      expect(c).toBeLessThan(mean * 1.25);
    }
  });

  it('S14 AS-23: sequential references also spread (no clustering on the last digits)', () => {
    const counts = new Array<number>(32).fill(0);
    for (let i = 0; i < 10_000; i++) counts[shardOf(`payment-${i}`, 32)]++;
    const mean = 10_000 / 32;
    for (const c of counts) {
      expect(c).toBeGreaterThan(mean * 0.75);
      expect(c).toBeLessThan(mean * 1.25);
    }
  });

  it('S14 AS-23: the three hot accounts of one journal share one shard index; others stay on shard 0', () => {
    fc.assert(
      fc.property(fc.uuid(), (key) => {
        const hot = [
          'PLATFORM_FEES',
          'PROVIDER_CLEARING',
          'MARKETPLACE_CLEARING',
        ].map((a) => shardFor(a, key, 32));
        return (
          new Set(hot).size === 1 &&
          shardFor('PAYOUT_CLEARING', key, 32) === 0 &&
          shardFor(`SHOP_${key}`, key, 32) === 0 &&
          shardFor('PAYOUTS_SENT', key, 32) === 0
        );
      }),
    );
  });

  it('S14 AS-23: changing N from 32 to 64 may move a reference but keeps it inside the range', () => {
    fc.assert(
      fc.property(fc.uuid(), (key) => {
        const a = shardOf(key, 32);
        const b = shardOf(key, 64);
        return a < 32 && b < 64;
      }),
    );
  });
});
