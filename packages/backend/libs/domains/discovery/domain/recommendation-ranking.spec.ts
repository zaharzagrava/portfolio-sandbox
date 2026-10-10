import fc from 'fast-check';
import { rankCandidates, type Candidate } from './recommendation-ranking';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('recommendation ranking', () => {
  it.each([
    {
      name: 'equal scores break by productId ascending',
      input: [
        { productId: id(3), score: 0.5, hops: 1 },
        { productId: id(1), score: 0.5, hops: 1 },
        { productId: id(2), score: 0.5, hops: 1 },
      ],
      expected: [id(1), id(2), id(3)],
    },
    {
      name: 'score descending',
      input: [
        { productId: id(1), score: 0.2, hops: 1 },
        { productId: id(2), score: 0.9, hops: 1 },
      ],
      expected: [id(2), id(1)],
    },
    {
      name: 'direct before indirect despite a lower score',
      input: [
        { productId: id(1), score: 0.9, hops: 2 },
        { productId: id(2), score: 0.1, hops: 1 },
      ],
      expected: [id(2), id(1)],
    },
    {
      name: 'ids compare by byte order, not by locale',
      input: [
        { productId: 'b0000000-0000-4000-8000-000000000000', score: 0.5, hops: 1 },
        { productId: 'A0000000-0000-4000-8000-000000000000', score: 0.5, hops: 1 },
      ],
      expected: [
        'A0000000-0000-4000-8000-000000000000',
        'b0000000-0000-4000-8000-000000000000',
      ],
    },
  ] as { name: string; input: Candidate[]; expected: string[] }[])(
    'S34 AS-02: $name',
    ({ input, expected }) => {
      expect(rankCandidates(input, 8).map((c) => c.productId)).toEqual(expected);
    },
  );

  it('S34 AS-02: the cut keeps the best `limit` and a replay is identical', () => {
    const input: Candidate[] = [1, 2, 3, 4, 5].map((n) => ({
      productId: id(n),
      score: n / 10,
      hops: 1,
    }));
    const first = rankCandidates(input, 3);
    expect(first.map((c) => c.productId)).toEqual([id(5), id(4), id(3)]);
    expect(rankCandidates(input, 3)).toEqual(first);
  });

  it('S34 AS-02: property - the order does not depend on the order of the input', () => {
    const candidate = fc.record({
      productId: fc.integer({ min: 0, max: 40 }).map(id),
      score: fc.constantFrom(0.1, 0.25, 0.5, 0.75, 1),
      hops: fc.constantFrom(1 as const, 2 as const),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(candidate, { selector: (c) => c.productId, maxLength: 30 }),
        fc.integer({ min: 1, max: 20 }),
        (candidates, limit) => {
          const shuffled = [...candidates].reverse();
          expect(rankCandidates(shuffled, limit)).toEqual(
            rankCandidates(candidates, limit),
          );
        },
      ),
    );
  });
});
