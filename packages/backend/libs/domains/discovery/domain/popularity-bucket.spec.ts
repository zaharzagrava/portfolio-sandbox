import fc from 'fast-check';
import {
  BOOST_TIERS,
  DEFAULT_BOOST_WEIGHTS,
  MAX_BOOST_MULTIPLIER,
  businessMultiplier,
  type BoostSignals,
  type BoostTier,
} from './boost';
import { MAX_POPULARITY_BUCKET, popularityBucket } from './popularity-bucket';

describe('popularity bucket (S32 AS-86)', () => {
  it.each([
    [0, 0],
    [1, 0],
    [3, 1],
    [9, 2],
    [120, 4],
    [999, 6],
    [99_999, 10],
    [1_000_000, 10],
    [Number.MAX_SAFE_INTEGER, 10],
  ])('S32 AS-86: %i clicks -> bucket %i', (clicks, bucket) => {
    expect(popularityBucket(clicks)).toBe(bucket);
  });

  it('S32 AS-86: 120 clicks outrank 2 clicks', () => {
    expect(popularityBucket(120)).toBeGreaterThan(popularityBucket(2));
  });

  it.each([-1, NaN, -Infinity, 1.7])('S32 AS-86: odd input %p stays an integer in range', (x) => {
    const b = popularityBucket(x);
    expect(Number.isInteger(b)).toBe(true);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThanOrEqual(MAX_POPULARITY_BUCKET);
  });

  it('S32 AS-86: monotone, bounded, integral, 0 for zero clicks', () => {
    fc.assert(
      fc.property(fc.nat(2 ** 31), fc.nat(2 ** 31), (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(popularityBucket(lo)).toBeLessThanOrEqual(popularityBucket(hi));
        expect(popularityBucket(hi)).toBeLessThanOrEqual(10);
        expect(Number.isInteger(popularityBucket(hi))).toBe(true);
        expect(popularityBucket(0)).toBe(0);
      }),
    );
  });

  it('S32 AS-86: logarithmic, a tenfold increase raises the bucket by at most 2', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000_000 }), (c) => {
        expect(
          popularityBucket(c * 10) - popularityBucket(c),
        ).toBeLessThanOrEqual(2);
      }),
    );
  });
});

describe('business multiplier (S32 AS-86, AS-06)', () => {
  const neutral: BoostSignals = {
    inStock: false,
    rating: null,
    popularityBucket: null,
    tier: null,
    sponsored: false,
  };

  it('S32 AS-05: missing signals are neutral (multiplier 1)', () => {
    expect(businessMultiplier(neutral)).toBe(1);
    expect(
      businessMultiplier({ ...neutral, rating: 0, popularityBucket: 0, tier: 'STARTER' }),
    ).toBe(1);
  });

  it('S32 AS-05: each signal raises the multiplier on its own', () => {
    const base = businessMultiplier(neutral);
    expect(businessMultiplier({ ...neutral, inStock: true })).toBeGreaterThan(base);
    expect(businessMultiplier({ ...neutral, rating: 5 })).toBeGreaterThan(
      businessMultiplier({ ...neutral, rating: 2 }),
    );
    expect(businessMultiplier({ ...neutral, popularityBucket: 9 })).toBeGreaterThan(
      businessMultiplier({ ...neutral, popularityBucket: 3 }),
    );
    expect(businessMultiplier({ ...neutral, tier: 'PRO' })).toBeGreaterThan(
      businessMultiplier({ ...neutral, tier: 'STARTER' }),
    );
    expect(businessMultiplier({ ...neutral, tier: 'ENTERPRISE' })).toBeGreaterThanOrEqual(
      businessMultiplier({ ...neutral, tier: 'PRO' }),
    );
    expect(businessMultiplier({ ...neutral, sponsored: true })).toBeGreaterThan(base);
  });

  it('S32 AS-06: the best possible product never exceeds 4', () => {
    const best = businessMultiplier({
      inStock: true,
      rating: 5,
      popularityBucket: 10,
      tier: 'ENTERPRISE',
      sponsored: true,
    });
    expect(best).toBeLessThanOrEqual(MAX_BOOST_MULTIPLIER);
    expect(MAX_BOOST_MULTIPLIER).toBe(4);
  });

  it('S32 AS-86: stays within [1, 4] for every combination', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.option(fc.double({ min: 0, max: 5, noNaN: true }), { nil: null }),
        fc.option(fc.integer({ min: 0, max: 10 }), { nil: null }),
        fc.option(fc.constantFrom<BoostTier>(...BOOST_TIERS), { nil: null }),
        fc.boolean(),
        (inStock, rating, bucket, tier, sponsored) => {
          const m = businessMultiplier({
            inStock,
            rating,
            popularityBucket: bucket,
            tier,
            sponsored,
          });
          expect(m).toBeGreaterThanOrEqual(1);
          expect(m).toBeLessThanOrEqual(4);
        },
      ),
    );
  });

  it('S32 AS-86: the documented defaults multiply: in stock x2, rating 1 + r/10, popularity 1 + bucket/20, PRO x1.1, ENTERPRISE x1.2, sponsored x1.3', () => {
    expect(businessMultiplier({ ...neutral, inStock: true })).toBeCloseTo(2);
    expect(businessMultiplier({ ...neutral, rating: 5 })).toBeCloseTo(1.5);
    expect(businessMultiplier({ ...neutral, popularityBucket: 10 })).toBeCloseTo(1.5);
    expect(businessMultiplier({ ...neutral, tier: 'PRO' })).toBeCloseTo(1.1);
    expect(businessMultiplier({ ...neutral, tier: 'ENTERPRISE' })).toBeCloseTo(1.2);
    expect(businessMultiplier({ ...neutral, sponsored: true })).toBeCloseTo(1.3);
    expect(
      businessMultiplier({
        inStock: true,
        rating: 5,
        popularityBucket: 10,
        tier: 'ENTERPRISE',
        sponsored: true,
      }),
    ).toBe(4);
  });

  it('S32 AS-86: the tier factor applies after the other factors are capped (engine-side recompute)', () => {
    const rest = { inStock: true, rating: 5, popularityBucket: 10, sponsored: true };
    const base = businessMultiplier({ ...rest, tier: null });
    expect(base).toBe(4);
    expect(businessMultiplier({ ...rest, tier: 'PRO' })).toBe(4);
    const mid = { inStock: true, rating: 2, popularityBucket: 0, sponsored: false };
    expect(businessMultiplier({ ...mid, tier: 'PRO' })).toBeCloseTo(
      businessMultiplier({ ...mid, tier: null }) * 1.1,
    );
  });

  it('S32 AS-86: stays within [1, 4] even with oversized weights', () => {
    const huge = {
      ...DEFAULT_BOOST_WEIGHTS,
      inStock: 50,
      rating: 50,
      popularity: 50,
      sponsored: 50,
      tier: { STARTER: 1, PRO: 50, ENTERPRISE: 100 },
    };
    expect(
      businessMultiplier(
        { inStock: true, rating: 5, popularityBucket: 10, tier: 'ENTERPRISE', sponsored: true },
        huge,
      ),
    ).toBe(4);
  });

  it('S32 AS-86: weights are a parameter (config can override)', () => {
    const none = { ...DEFAULT_BOOST_WEIGHTS, inStock: 1 };
    expect(businessMultiplier({ ...neutral, inStock: true }, none)).toBe(1);
  });

  it('S32 AS-86: out-of-range inputs are clamped, not propagated', () => {
    const m = businessMultiplier({
      inStock: true,
      rating: 99,
      popularityBucket: 99,
      tier: null,
      sponsored: false,
    });
    expect(m).toBe(
      businessMultiplier({ inStock: true, rating: 5, popularityBucket: 10, tier: null, sponsored: false }),
    );
  });
});
