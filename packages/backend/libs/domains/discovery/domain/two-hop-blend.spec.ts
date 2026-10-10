import fc from 'fast-check';
import { blendTwoHop } from './two-hop-blend';
import { rankCandidates } from './recommendation-ranking';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [X, Y, Z, W] = [1, 2, 3, 4].map(id);
const DECAY = 0.5;

type List = { id: string; score: number }[];
const lists = (graph: Record<string, List>) => {
  const direct = graph[X] ?? [];
  return {
    direct,
    seeds: direct.map((seed) => ({ seed, list: graph[seed.id] ?? [] })),
  };
};

describe('two-hop blend', () => {
  it('S34 AS-17: the best path wins, a direct neighbour stays direct, the product never lists itself', () => {
    const { direct, seeds } = lists({
      [X]: [
        { id: Y, score: 0.9 },
        { id: Z, score: 0.8 },
      ],
      [Y]: [
        { id: W, score: 0.6 },
        { id: Z, score: 0.5 },
        { id: X, score: 0.9 },
      ],
      [Z]: [
        { id: W, score: 0.8 },
        { id: X, score: 0.8 },
      ],
    });

    const out = blendTwoHop(X, direct, seeds, DECAY);

    const byId = new Map(out.map((c) => [c.productId, c]));
    expect(byId.get(W)).toMatchObject({ productId: W, hops: 2 });
    expect(byId.get(W)!.score).toBeCloseTo(0.32, 10);
    expect(byId.get(Z)).toEqual({ productId: Z, score: 0.8, hops: 1 });
    expect(byId.get(Y)).toEqual({ productId: Y, score: 0.9, hops: 1 });
    expect(byId.has(X)).toBe(false);
    expect(out.filter((c) => c.productId === W)).toHaveLength(1);
  });

  it('S34 AS-18: a weaker direct neighbour precedes a stronger indirect one', () => {
    const { direct, seeds } = lists({
      [X]: [
        { id: Y, score: 0.9 },
        { id: Z, score: 0.2 },
      ],
      [Y]: [
        { id: W, score: 0.8 },
        { id: X, score: 0.9 },
      ],
    });

    const ranked = rankCandidates(blendTwoHop(X, direct, seeds, DECAY), 8);

    expect(ranked.map((c) => [c.productId, c.hops, Math.round(c.score * 100) / 100])).toEqual([
      [Y, 1, 0.9],
      [Z, 1, 0.2],
      [W, 2, 0.36],
    ]);
  });

  it('S34 AS-17: no seeds and no direct entries give nothing', () => {
    expect(blendTwoHop(X, [], [], DECAY)).toEqual([]);
  });

  it('S34 AS-17: property - adding a path never lowers a score', () => {
    const entry = fc.record({
      id: fc.integer({ min: 2, max: 12 }).map(id),
      score: fc.constantFrom(0.1, 0.3, 0.6, 0.9),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(entry, { selector: (e) => e.id, maxLength: 5 }),
        fc.uniqueArray(entry, { selector: (e) => e.id, maxLength: 6 }),
        entry,
        (direct, secondHop, extra) => {
          const seeds = (more: List) =>
            direct.map((seed, i) => ({ seed, list: i === 0 ? more : secondHop }));
          const before = new Map(
            blendTwoHop(X, direct, seeds(secondHop), DECAY).map((c) => [c.productId, c.score]),
          );
          const withExtra = secondHop.some((e) => e.id === extra.id)
            ? secondHop
            : [...secondHop, extra];
          const after = new Map(
            blendTwoHop(X, direct, seeds(withExtra), DECAY).map((c) => [c.productId, c.score]),
          );
          for (const [productId, score] of before)
            expect(after.get(productId) ?? 0).toBeGreaterThanOrEqual(score);
        },
      ),
    );
  });
});
