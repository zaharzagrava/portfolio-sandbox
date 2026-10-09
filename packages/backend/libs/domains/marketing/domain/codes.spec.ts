import {
  fromBase62,
  scramble,
  toBase62,
  unscramble,
  CODE_LENGTH,
} from './codes';

/** The code scheme is shared by every short-code consumer (links now, invite/referral codes later). */
describe('short codes', () => {
  it('base62 round-trips and pads to 7 chars', () => {
    for (const n of [0, 1, 61, 62, 3_843, 2 ** 40 - 1])
      expect(fromBase62(toBase62(n))).toBe(n);
    expect(toBase62(1)).toHaveLength(CODE_LENGTH);
    expect(toBase62(2 ** 40 - 1)).toHaveLength(CODE_LENGTH);
  });

  it('Feistel scramble is a keyed permutation: unique, invertible, non-sequential', () => {
    const seen = new Set<number>();
    for (let id = 1; id <= 5_000; id++) {
      const s = scramble(id, 'secret');
      expect(unscramble(s, 'secret')).toBe(id);
      seen.add(s);
    }
    expect(seen.size).toBe(5_000);
    expect(
      Math.abs(scramble(2, 'secret') - scramble(1, 'secret')),
    ).toBeGreaterThan(1_000);
    expect(scramble(1, 'secret')).not.toBe(scramble(1, 'other-key'));
  });
});
