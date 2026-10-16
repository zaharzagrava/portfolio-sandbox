import { isValidCommentLength, normalizeComment } from './comment-text';

describe('normalizeComment', () => {
  it.each([
    ['plain text stays', 'Take my money!', 'Take my money!'],
    ['leading and trailing blanks go', '   hello   ', 'hello'],
    ['runs of whitespace collapse', 'a  b\t\tc\n\nd', 'a b c d'],
    ['control characters go', 'a\u0000b\u0007c\u007fd', 'abcd'],
    ['zero-width characters go', 'sc​am‌﻿!', 'scam!'],
    ['combining marks compose (NFC)', 'café', 'café'],
    ['a blank text is empty', ' \t\n​ ', ''],
  ])('S23 AS-17: %s', (_name, raw, expected) => {
    expect(normalizeComment(raw).text).toBe(expected);
  });

  it.each([
    ['ascii', 'abc', 3],
    ['astral emoji counts as one code point', '😀😀', 2],
    ['an emoji sequence counts its code points', '👨‍👩‍👧', 5],
    ['after normalization, not before', 'a​​b', 2],
  ])('S23 AS-17: length is in code points: %s', (_name, raw, length) => {
    expect(normalizeComment(raw).length).toBe(length);
  });

  it('S23 AS-17: exactly 200 code points are valid, 201 and 0 are not', () => {
    expect(
      isValidCommentLength(normalizeComment('😀'.repeat(200)).length),
    ).toBe(true);
    expect(
      isValidCommentLength(normalizeComment('😀'.repeat(201)).length),
    ).toBe(false);
    expect(isValidCommentLength(normalizeComment('  ').length)).toBe(false);
  });
});
