import {
  MAX_CANDIDATES,
  SEARCH_RADII_M,
  rankCandidates,
  type Candidate,
} from './candidate-ranking';

const at = (courierId: string, distanceM: number): Candidate => ({
  courierId,
  distanceM,
});

describe('candidate ranking', () => {
  it('S20 AS-18: the radii are 3, 6 and 12 km and a search considers at most 20 candidates', () => {
    expect(SEARCH_RADII_M).toEqual([3_000, 6_000, 12_000]);
    expect(MAX_CANDIDATES).toBe(20);
  });

  it('S20 AS-18: nearer comes first', () => {
    const ranked = rankCandidates([
      at('c5', 5_000),
      at('c1', 300),
      at('c3', 2_500),
    ]);
    expect(ranked.map((c) => c.courierId)).toEqual(['c1', 'c3', 'c5']);
  });

  it('S20 AS-18: equal distance is broken by courier id', () => {
    const ranked = rankCandidates([at('b', 100), at('a', 100), at('c', 100)]);
    expect(ranked.map((c) => c.courierId)).toEqual(['a', 'b', 'c']);
  });

  it('S20 AS-18: a courier found in several radius steps counts once, at the shortest distance', () => {
    const ranked = rankCandidates([
      at('a', 2_000),
      at('a', 2_000),
      at('b', 100),
    ]);
    expect(ranked.map((c) => c.courierId)).toEqual(['b', 'a']);
  });

  it('S20 AS-18: the cap of 20 holds across all radii, not per step', () => {
    const step3 = Array.from({ length: 12 }, (_, i) => at(`n${i}`, 100 + i));
    const step6 = Array.from({ length: 12 }, (_, i) => at(`m${i}`, 3_100 + i));
    const step12 = Array.from({ length: 12 }, (_, i) => at(`f${i}`, 6_100 + i));
    const ranked = rankCandidates([...step3, ...step6, ...step12]);
    expect(ranked).toHaveLength(20);
    expect(ranked.slice(0, 12).every((c) => c.courierId.startsWith('n'))).toBe(
      true,
    );
    expect(ranked.slice(12).every((c) => c.courierId.startsWith('m'))).toBe(
      true,
    );
  });

  it('S20 AS-18: the input is not mutated and an empty list ranks to nothing', () => {
    const input = [at('b', 2), at('a', 1)];
    rankCandidates(input);
    expect(input.map((c) => c.courierId)).toEqual(['b', 'a']);
    expect(rankCandidates([])).toEqual([]);
  });

  it('S20 AS-18: a custom limit is honoured', () => {
    expect(
      rankCandidates([at('a', 1), at('b', 2), at('c', 3)], 2),
    ).toHaveLength(2);
  });
});
