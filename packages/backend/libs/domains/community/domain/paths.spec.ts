import { TimeIdGenerator, type RandomSource } from './ids';
import {
  assignRootSlot,
  childDepth,
  depthOf,
  MAX_DEPTH,
  pathFor,
  rootPathOf,
  subtreeRange,
} from './paths';

const seeded = (seed: number): RandomSource => {
  let s = seed;
  return {
    bytes(length) {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        out[i] = s & 0xff;
      }
      return out;
    },
  };
};

describe('comment thread positions', () => {
  const gen = new TimeIdGenerator(seeded(5));
  const at = (n: number) => new Date(Date.UTC(2026, 9, 13, 12, 0, n));

  it('S25 AS-14: thread order is path order: parents before children, siblings by creation time', () => {
    const a = pathFor(null, gen.next(at(1)));
    const b = pathFor(null, gen.next(at(2)));
    const a1 = pathFor(a, gen.next(at(3)));
    const a1x = pathFor(a1, gen.next(at(4)));
    const a2 = pathFor(a, gen.next(at(5)));
    expect([b, a2, a1x, a, a1].sort()).toEqual([a, a1, a1x, a2, b]);
  });

  it('S25 AS-14: a subtree range holds exactly the descendants of a path', () => {
    const a = pathFor(null, gen.next(at(1)));
    const a1 = pathFor(a, gen.next(at(2)));
    const b = pathFor(null, gen.next(at(3)));
    const { from, to } = subtreeRange(a);
    expect(a1 >= from && a1 < to).toBe(true);
    expect(a >= from && a < to).toBe(false);
    expect(b >= from && b < to).toBe(false);
  });

  it.each([
    [0, 1],
    [1, 2],
    [4, 5],
    [7, 8],
  ])(
    'S25 AS-13: a reply under depth %i has depth %i',
    (parentDepth, expected) => {
      expect(childDepth(parentDepth)).toBe(expected);
    },
  );

  it.each([
    [7, true],
    [8, false],
    [9, false],
  ])(
    'S25 AS-15: a parent at depth %i %s accepts a reply (maximum depth %i)',
    (parentDepth, ok) => {
      expect(childDepth(parentDepth) <= MAX_DEPTH).toBe(ok);
    },
  );

  it('S25 AS-18: depth and root come from the path alone', () => {
    let path = pathFor(null, gen.next(at(1)));
    const root = path;
    expect(depthOf(path)).toBe(0);
    for (let d = 1; d <= MAX_DEPTH; d++) {
      path = pathFor(path, gen.next(at(1 + d)));
      expect(depthOf(path)).toBe(d);
      expect(rootPathOf(path)).toBe(root);
    }
  });
});

describe('top-level comment partition assignment', () => {
  it.each([
    [undefined, 5, { bucket: 0, filled: 1 }],
    [{ bucket: 0, filled: 1 }, 5, { bucket: 0, filled: 2 }],
    [{ bucket: 0, filled: 4 }, 5, { bucket: 0, filled: 5 }],
    [{ bucket: 0, filled: 5 }, 5, { bucket: 1, filled: 1 }],
    [{ bucket: 7, filled: 5000 }, 5000, { bucket: 8, filled: 1 }],
  ])(
    'S25 AS-18: slot after %j with partition size %i is %j',
    (state, size, expected) => {
      expect(assignRootSlot(state, size)).toEqual(expected);
    },
  );

  it('S25 AS-18: 12 roots with partition size 5 fill buckets 0, 0, 0, 0, 0, 1 ... 2', () => {
    let state: { bucket: number; filled: number } | undefined;
    const buckets: number[] = [];
    for (let i = 0; i < 12; i++) {
      state = assignRootSlot(state, 5);
      buckets.push(state.bucket);
    }
    expect(buckets).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2]);
  });
});
