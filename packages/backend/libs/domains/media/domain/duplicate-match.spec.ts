import fc from 'fast-check';
import {
  bands,
  CANDIDATE_CAP,
  findNearest,
  hamming,
  isNearUniform,
  NEAR_DUPLICATE_BITS,
} from './duplicate-match';

const hex = (n: bigint) => n.toString(16).padStart(16, '0');
const base = 0x0f1e2d3c4b5a6978n;
const flip = (value: bigint, bits: number[]) =>
  bits.reduce((acc, bit) => acc ^ (1n << BigInt(bit)), value);

describe('duplicate matching', () => {
  it('S29 AS-27: distance 3 matches and distance 4 does not', () => {
    const at3 = { id: 'b', hash: hex(flip(base, [0, 20, 40])) };
    const at4 = { id: 'c', hash: hex(flip(base, [0, 20, 40, 60])) };
    expect(hamming(hex(base), at3.hash)).toBe(3);
    expect(findNearest(hex(base), [at3])).toEqual({ id: 'b', distance: 3 });
    expect(findNearest(hex(base), [at4])).toBeNull();
    expect(NEAR_DUPLICATE_BITS).toBe(3);
  });

  it('S29 AS-27: the nearest candidate wins', () => {
    const near = { id: 'z', hash: hex(flip(base, [1])) };
    const far = { id: 'a', hash: hex(flip(base, [1, 2, 3])) };
    expect(findNearest(hex(base), [far, near])).toEqual({
      id: 'z',
      distance: 1,
    });
  });

  it('S29 AS-27: ties go to the smallest id (the earliest, ids are time-ordered)', () => {
    const a = { id: '0192-b', hash: hex(flip(base, [5])) };
    const b = { id: '0192-a', hash: hex(flip(base, [9])) };
    expect(findNearest(hex(base), [a, b])?.id).toBe('0192-a');
    expect(findNearest(hex(base), [b, a])?.id).toBe('0192-a');
  });

  it.each([
    ['all zero', 0n, true],
    ['all one', 0xffffffffffffffffn, true],
    ['seven set bits', 0x7fn, true],
    ['seven clear bits', 0xffffffffffffff80n, true],
    ['eight set bits', 0xffn, false],
    ['eight clear bits', 0xffffffffffffff00n, false],
    ['a normal hash', base, false],
  ])('S29 AS-27: near-uniform check (%s)', (_name, value, expected) => {
    expect(isNearUniform(hex(value))).toBe(expected);
  });

  it('S29 AS-27: a near-uniform hash never matches and is never matched', () => {
    const blank = hex(0n);
    expect(findNearest(blank, [{ id: 'a', hash: blank }])).toBeNull();
    expect(findNearest(hex(base), [{ id: 'a', hash: hex(0xffn) }])).toBeNull();
    expect(
      findNearest(hex(base), [{ id: 'a', hash: hex(0xffffffffffffff80n) }]),
    ).toBeNull();
  });

  it('S29 AS-28: the cap is 500', () => {
    expect(CANDIDATE_CAP).toBe(500);
  });

  it('S29 AS-28: any copy within 3 flipped bits shares at least one 16-bit band', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 0xffffffffffffffffn }),
        fc.uniqueArray(fc.integer({ min: 0, max: 63 }), {
          minLength: 0,
          maxLength: NEAR_DUPLICATE_BITS,
        }),
        (value, bits) => {
          const original = bands(hex(value));
          const copy = bands(hex(flip(value, bits)));
          return original.some((band, index) => band === copy[index]);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('S29 AS-28: bands split the 64-bit hash into four 16-bit values', () => {
    expect(bands('0123456789abcdef')).toEqual([0x0123, 0x4567, 0x89ab, 0xcdef]);
  });
});
