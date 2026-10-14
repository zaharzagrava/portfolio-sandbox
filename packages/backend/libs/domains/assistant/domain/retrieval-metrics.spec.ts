import {
  evaluateRetrieval,
  firstRelevantRank,
  reciprocalRank,
} from './retrieval-metrics';

describe('S47 AS-49: retrieval metrics (pure)', () => {
  const K = 5;
  const ranked = (hitAt: number | null, length = K + 3) =>
    Array.from({ length }, (_, i) =>
      i + 1 === hitAt ? 'target' : `other-${i}`,
    );

  it.each([
    ['a hit at rank 1', ranked(1), ['target'], 1, 1],
    ['a hit at rank k', ranked(K), ['target'], K, 1 / K],
    [
      'a hit at rank k + 1 (outside the top k)',
      ranked(K + 1),
      ['target'],
      null,
      0,
    ],
    ['nothing expected', ranked(1), [], null, 0],
    ['an empty result list', [], ['target'], null, 0],
    [
      'the second of two expected documents',
      ranked(2),
      ['missing', 'target'],
      2,
      1 / 2,
    ],
    [
      'the earliest of two expected documents',
      ['a', 'b', 'c'],
      ['c', 'b'],
      2,
      1 / 2,
    ],
  ])('S47 AS-49: %s', (_name, retrieved, expected, rank, rr) => {
    expect(firstRelevantRank(retrieved, expected, K)).toBe(rank);
    expect(reciprocalRank(retrieved, expected, K)).toBeCloseTo(rr, 12);
  });

  it('S47 AS-49: recall@k is the share of cases with an expected document in the top k; MRR is the mean reciprocal rank', () => {
    const report = evaluateRetrieval(
      [
        { retrieved: ranked(1), expected: ['target'] }, // rr 1
        { retrieved: ranked(K), expected: ['target'] }, // rr 1/5
        { retrieved: ranked(K + 1), expected: ['target'] }, // miss
        { retrieved: [], expected: ['target'] }, // miss
      ],
      K,
    );
    expect(report.cases).toBe(4);
    expect(report.hits).toBe(2);
    expect(report.recallAtK).toBeCloseTo(2 / 4, 12);
    expect(report.mrr).toBeCloseTo((1 + 1 / 5) / 4, 12);
  });

  it('S47 AS-49: no cases is not a pass: recall 0 and MRR 0', () => {
    expect(evaluateRetrieval([], K)).toEqual({
      cases: 0,
      hits: 0,
      recallAtK: 0,
      mrr: 0,
    });
  });
});
