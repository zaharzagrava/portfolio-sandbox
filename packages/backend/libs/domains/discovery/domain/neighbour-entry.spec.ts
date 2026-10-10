import { sanitiseEntries } from './neighbour-entry';

const X = '00000000-0000-4000-8000-0000000000aa';
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const BAD = '00000000-0000-4000-8000-0000000000bb';

describe('stored neighbour entries', () => {
  it.each([
    ['a member that is not a UUID', { member: 'not-a-uuid', score: 0.5 }],
    ['the requested product itself', { member: X, score: 0.5 }],
    ['a score that is NaN', { member: BAD, score: Number.NaN }],
    ['a negative score', { member: BAD, score: -0.1 }],
    ['a zero score', { member: BAD, score: 0 }],
    ['a score above 1', { member: BAD, score: 1.0001 }],
    ['an infinite score', { member: BAD, score: Number.POSITIVE_INFINITY }],
    ['a missing score', { member: BAD, score: undefined }],
    ['a null score', { member: BAD, score: null }],
  ])('S34 AS-21: skips %s and counts it', (_name, bad) => {
    const result = sanitiseEntries(X, [
      { member: A, score: 0.4 },
      bad,
      { member: B, score: 0.3 },
    ]);
    expect(result).toEqual({
      entries: [
        { id: A, score: 0.4 },
        { id: B, score: 0.3 },
      ],
      skipped: 1,
    });
  });

  it('S34 AS-21: keeps the valid entries in their order, with a score of exactly 1', () => {
    expect(
      sanitiseEntries(X, [
        { member: A, score: 1 },
        { member: B, score: 0.0001 },
      ]),
    ).toEqual({
      entries: [
        { id: A, score: 1 },
        { id: B, score: 0.0001 },
      ],
      skipped: 0,
    });
  });
});
