import { reciprocalRankFusion } from './rrf';

const ids = (fused: { id: string }[]) => fused.map((f) => f.id);

describe('S47 AS-44: reciprocal rank fusion', () => {
  it('S47 AS-44: an id ranked well by both lists beats an id that is first in only one, with exact scores', () => {
    const fused = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['b', 'd', 'a'],
    ]);
    expect(ids(fused)).toEqual(['b', 'a', 'd', 'c']);
    const score = Object.fromEntries(fused.map((f) => [f.id, f.score]));
    expect(score.b).toBeCloseTo(1 / 62 + 1 / 61, 12); // rank 2 and rank 1
    expect(score.a).toBeCloseTo(1 / 61 + 1 / 63, 12); // rank 1 and rank 3
    expect(score.d).toBeCloseTo(1 / 62, 12);
    expect(score.c).toBeCloseTo(1 / 63, 12);
    expect(score.b).toBeGreaterThan(score.a);
  });

  it.each([
    [
      'a single list keeps its order',
      [['x', 'y', 'z']],
      ['x', 'y', 'z'],
      [1 / 61, 1 / 62, 1 / 63],
    ],
    ['no lists', [], [], []],
    ['empty lists', [[], []], [], []],
    [
      'one empty list among others',
      [['x'], [], ['y']],
      ['x', 'y'],
      [1 / 61, 1 / 61],
    ],
    [
      'a tie keeps the first-seen order',
      [['y'], ['x']],
      ['y', 'x'],
      [1 / 61, 1 / 61],
    ],
    [
      'a tie across three lists keeps the first-seen order',
      [['p', 'q'], ['q', 'p'], ['r']],
      ['p', 'q', 'r'],
      [1 / 61 + 1 / 62, 1 / 62 + 1 / 61, 1 / 61],
    ],
  ])('S47 AS-44: %s', (_name, lists, order, scores) => {
    const fused = reciprocalRankFusion(lists as string[][]);
    expect(ids(fused)).toEqual(order);
    fused.forEach((f, i) => expect(f.score).toBeCloseTo(scores[i], 12));
  });

  it('S47 AS-44: an id repeated inside one list counts once, at its best rank', () => {
    const fused = reciprocalRankFusion([['a', 'b', 'a', 'a'], ['c']]);
    const score = Object.fromEntries(fused.map((f) => [f.id, f.score]));
    expect(score.a).toBeCloseTo(1 / 61, 12); // not 1/61 + 1/63 + 1/64
    expect(score.b).toBeCloseTo(1 / 62, 12);
    expect(ids(fused)).toEqual(['a', 'c', 'b']); // a and c tie at 1/61: a was seen first
  });

  it('S47 AS-44: the constant is 60, and a different constant changes the scores as the formula says', () => {
    expect(reciprocalRankFusion([['a']])[0].score).toBeCloseTo(1 / 61, 12);
    expect(reciprocalRankFusion([['a']], 10)[0].score).toBeCloseTo(1 / 11, 12);
  });

  it('S47 AS-44: the result is ordered by descending score', () => {
    const fused = reciprocalRankFusion([
      ['a', 'b', 'c', 'd'],
      ['d', 'c', 'b', 'a'],
      ['b', 'a'],
    ]);
    for (let i = 1; i < fused.length; i++)
      expect(fused[i - 1].score).toBeGreaterThanOrEqual(fused[i].score);
  });
});
