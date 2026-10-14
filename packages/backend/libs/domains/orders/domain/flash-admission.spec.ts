import * as fc from 'fast-check';
import { admit, allowance, retryAfterSeconds } from './flash-admission';

describe('S11 AS-46: flash admission allowance', () => {
  it.each([
    [100, 100, 0, 0, 0],
    [100, 100, 0, 10, 1],
    [100, 100, 0, 1000, 100],
    [100, 100, 50, 1000, 100],
    [100, 100, 99.5, 10, 100],
    [2000, 2000, 0, 1, 2],
  ])('S11 AS-46: rate %i burst %i tokens %f elapsed %i ms -> %f', (rate, burst, tokens, elapsedMs, expected) => {
    expect(allowance({ rate, burst, tokens, elapsedMs }).tokens).toBeCloseTo(expected, 9);
  });

  it('S11 AS-46: a clock that moves backwards mints no tokens', () => {
    expect(allowance({ rate: 100, burst: 100, tokens: 3, elapsedMs: -5000 }).tokens).toBe(3);
  });

  it('S11 AS-46: allowance stays within [0, burst] and refills linearly', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.double({ min: 0, max: 10_000, noNaN: true }),
        fc.integer({ min: -10_000, max: 120_000 }),
        (rate, tokensRaw, elapsedMs) => {
          const burst = rate;
          const tokens = Math.min(tokensRaw, burst);
          const next = allowance({ rate, burst, tokens, elapsedMs }).tokens;
          expect(next).toBeGreaterThanOrEqual(0);
          expect(next).toBeLessThanOrEqual(burst);
          expect(next).toBeGreaterThanOrEqual(tokens);
          if (elapsedMs > 0)
            expect(next).toBeCloseTo(
              Math.min(burst, tokens + (elapsedMs * rate) / 1000),
              6,
            );
        },
      ),
    );
  });

  it('S11 AS-46: admit takes one token; 300 attempts at rate 100 admit 100, then 1 s later 100 more', () => {
    let state = { tokens: 100, updatedAtMs: 1_000 };
    let admitted = 0;
    for (let i = 0; i < 300; i++) {
      const r = admit(state, 100, 1_000);
      state = r.state;
      if (r.admitted) admitted++;
    }
    expect(admitted).toBe(100);
    admitted = 0;
    for (let i = 0; i < 300; i++) {
      const r = admit(state, 100, 2_000);
      state = r.state;
      if (r.admitted) admitted++;
    }
    expect(admitted).toBe(100);
  });

  it('S11 AS-46: advance 10 ms at rate 100 admits at most 1', () => {
    let state = { tokens: 0, updatedAtMs: 5_000 };
    let admitted = 0;
    for (let i = 0; i < 20; i++) {
      const r = admit(state, 100, 5_010);
      state = r.state;
      if (r.admitted) admitted++;
    }
    expect(admitted).toBe(1);
  });

  it('S11 AS-46: a first call (no state) starts with a full burst', () => {
    const r = admit(null, 100, 0);
    expect(r.admitted).toBe(true);
    expect(r.state.tokens).toBe(99);
  });

  it('S11 AS-46: retryAfterSeconds is always 1..3', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (random) => {
        const s = retryAfterSeconds(random);
        expect([1, 2, 3]).toContain(s);
      }),
    );
    expect(retryAfterSeconds(0)).toBe(1);
    expect(retryAfterSeconds(0.999999)).toBe(3);
    expect(retryAfterSeconds(1)).toBe(3);
  });
});
