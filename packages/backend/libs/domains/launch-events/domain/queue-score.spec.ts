import { joinScore } from './queue-score';

const OPEN = Date.parse('2026-10-16T12:00:00.000Z');

/** A seeded random source (mulberry32) so the table is repeatable. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('S22 queue ordering rule', () => {
  it.each([-3_600_000, -60_000, -5_000, -1, -1000])(
    'S22 AS-03: a join %i ms before opening scores inside [open, open + 1 s) whatever the instant',
    (offset) => {
      const random = seeded(7);
      for (let i = 0; i < 200; i++) {
        const score = joinScore({
          nowMs: OPEN + offset,
          salesOpenAtMs: OPEN,
          random,
        });
        expect(score).toBeGreaterThanOrEqual(OPEN);
        expect(score).toBeLessThan(OPEN + 1000);
      }
    },
  );

  it('S22 AS-03: pre-sale scores spread across the second (not a constant)', () => {
    const random = seeded(11);
    const scores = new Set(
      Array.from({ length: 50 }, () =>
        joinScore({ nowMs: OPEN - 10_000, salesOpenAtMs: OPEN, random }),
      ),
    );
    expect(scores.size).toBeGreaterThan(30);
  });

  it.each([
    [0, OPEN + 1000],
    [500, OPEN + 1000],
    [999, OPEN + 1000],
    [1000, OPEN + 1000],
    [1500, OPEN + 1500],
    [60_000, OPEN + 60_000],
  ])(
    'S22 AS-03: a join %i ms after opening scores max(now, open + 1 s) = %i',
    (offset, expected) => {
      expect(
        joinScore({
          nowMs: OPEN + offset,
          salesOpenAtMs: OPEN,
          random: () => 0.5,
        }),
      ).toBe(expected);
    },
  );

  it('S22 AS-03: every pre-sale joiner is ahead of every post-open joiner; post-open ones follow join order', () => {
    const random = seeded(3);
    const pre = [-5000, -100, -1].map((o) =>
      joinScore({ nowMs: OPEN + o, salesOpenAtMs: OPEN, random }),
    );
    const post = [0, 700, 1200, 2500].map((o) =>
      joinScore({ nowMs: OPEN + o, salesOpenAtMs: OPEN, random }),
    );
    expect(Math.max(...pre)).toBeLessThan(Math.min(...post));
    expect([...post].sort((a, b) => a - b)).toEqual(post);
  });
});
