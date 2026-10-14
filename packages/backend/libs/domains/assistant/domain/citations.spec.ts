import type { AnswerBlock } from './ports';
import { citationsOf } from './citations';

const r = (index: number) => ({ kind: 'result' as const, index });
const other = { kind: 'other' as const, index: 0 };
const block = (text: string, citations: AnswerBlock['citations']) => ({
  text,
  citations,
});

describe('S47 AS-12: citation integrity (pure)', () => {
  it.each([
    [
      'duplicates, out of range and negative',
      [r(0), r(0), r(2), r(9), r(-1)],
      3,
      [0, 2],
    ],
    ['order of first appearance, not ascending', [r(2), r(0), r(2)], 3, [2, 0]],
    ['a location of another kind is dropped', [r(1), other], 3, [1]],
    ['only another kind', [other], 3, []],
    ['index equal to the item count', [r(3)], 3, []],
    ['no citation at all', [], 3, []],
  ])('S47 AS-12: %s', (_name, citations, count, sources) => {
    expect(citationsOf([block('Yes.', citations)], count).citations).toEqual([
      { text: 'Yes.', sources },
    ]);
  });

  it('S47 AS-12: empty text blocks are dropped', () => {
    const result = citationsOf([block('', [r(0)]), block('Yes.', [r(0)])], 1);
    expect(result.citations).toEqual([{ text: 'Yes.', sources: [0] }]);
  });

  it('S47 AS-12: grounded when at least one block carries a valid index', () => {
    expect(citationsOf([block('A', []), block('B', [r(1)])], 2).grounded).toBe(
      true,
    );
  });

  it('S47 AS-12: no valid citation → blocks with empty sources and grounded false', () => {
    const result = citationsOf(
      [block('A', [r(7)]), block('B', [other]), block('C', [])],
      2,
    );
    expect(result).toEqual({
      citations: [
        { text: 'A', sources: [] },
        { text: 'B', sources: [] },
        { text: 'C', sources: [] },
      ],
      grounded: false,
    });
  });

  it('S47 AS-12: no blocks at all is not grounded', () => {
    expect(citationsOf([], 3)).toEqual({ citations: [], grounded: false });
  });
});
