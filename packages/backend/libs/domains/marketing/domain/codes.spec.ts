import fc from 'fast-check';
import {
  CODE_SPACE,
  fromBase62,
  scramble,
  toBase62,
  unscramble,
  CODE_LENGTH,
} from './codes';
import { CodeRangeError } from './link-errors';

const KEY = 'test-share-link-code-key-0123456789abcdef';
const ALPHABET = /^[0-9A-Za-z]{7}$/;

/** The code scheme is shared by every short-code consumer (links now, invite/referral codes later). */
describe('S37 AS-05: short codes (G22)', () => {
  it('base62 round-trips and pads to 7 chars', () => {
    for (const n of [0, 1, 61, 62, 3_843, 2 ** 40 - 1])
      expect(fromBase62(toBase62(n))).toBe(n);
    expect(toBase62(1)).toHaveLength(CODE_LENGTH);
    expect(toBase62(2 ** 40 - 1)).toHaveLength(CODE_LENGTH);
  });

  it('Feistel scramble is a keyed permutation: unique, invertible, non-sequential', () => {
    const seen = new Set<number>();
    for (let id = 1; id <= 5_000; id++) {
      const s = scramble(id, KEY);
      expect(unscramble(s, KEY)).toBe(id);
      seen.add(s);
    }
    expect(seen.size).toBe(5_000);
    expect(Math.abs(scramble(2, KEY) - scramble(1, KEY))).toBeGreaterThan(
      1_000,
    );
    expect(scramble(1, KEY)).not.toBe(scramble(1, 'other-key'));
  });

  it('10,000 consecutive numbers give 10,000 distinct 7-character codes in the alphabet', () => {
    const codes = new Set<string>();
    for (let id = 1; id <= 10_000; id++) {
      const code = toBase62(scramble(id, KEY));
      expect(code).toMatch(ALPHABET);
      codes.add(code);
    }
    expect(codes.size).toBe(10_000);
  });

  it('range edges: 0 and 2^40 - 1 are accepted, out of range is a typed error', () => {
    expect(toBase62(scramble(0, KEY))).toMatch(ALPHABET);
    expect(toBase62(scramble(CODE_SPACE - 1, KEY))).toMatch(ALPHABET);
    for (const bad of [-1, CODE_SPACE, 1.5, Number.NaN])
      expect(() => scramble(bad, KEY)).toThrow(CodeRangeError);
  });

  describe('properties (fixed seed)', () => {
    const numbers = fc.integer({ min: 0, max: CODE_SPACE - 1 });

    it('bijection: unscramble inverts scramble', () => {
      fc.assert(
        fc.property(numbers, (n) => unscramble(scramble(n, KEY), KEY) === n),
        { seed: 20260713, numRuns: 500 },
      );
    });

    it('range: the scrambled value stays inside the 40-bit space and fits 7 characters', () => {
      fc.assert(
        fc.property(numbers, (n) => {
          const s = scramble(n, KEY);
          return s >= 0 && s < CODE_SPACE && ALPHABET.test(toBase62(s));
        }),
        { seed: 20260713, numRuns: 500 },
      );
    });

    it('non-adjacency: consecutive numbers do not give adjacent values', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: CODE_SPACE - 2 }),
          (n) => Math.abs(scramble(n + 1, KEY) - scramble(n, KEY)) > 1,
        ),
        { seed: 20260713, numRuns: 500 },
      );
    });

    it('key dependence: another key gives another code for (nearly) every number', () => {
      let same = 0;
      fc.assert(
        fc.property(numbers, (n) => {
          if (scramble(n, KEY) === scramble(n, `${KEY}-other`)) same++;
          return true;
        }),
        { seed: 20260713, numRuns: 500 },
      );
      expect(same).toBeLessThanOrEqual(1);
    });
  });
});
