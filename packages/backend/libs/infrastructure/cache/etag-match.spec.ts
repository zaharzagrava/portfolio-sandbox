import { matchesIfNoneMatch } from './etag-match';

describe('If-None-Match evaluation (RFC 9110 weak comparison)', () => {
  const strong = '"x-v2"';

  it.each([
    ['a strong tag', '"x-v2"', true],
    ['a weak tag', 'W/"x-v2"', true],
    ['a list with the tag second', '"a", "x-v2"', true],
    ['a list with spaces around the comma', '"a" , W/"x-v2"', true],
    ['a list with the tag first', '"x-v2","a"', true],
    ['the wildcard', '*', true],
    ['the wildcard with surrounding spaces', '  *  ', true],
    ['a comma inside a quoted tag', '"a,b", "x-v2"', true],
    ['empty list elements', '"a",, "x-v2",', true],
    ['a different version', '"x-v3"', false],
    ['an empty tag', '""', false],
    ['a lone weak prefix', 'W/', false],
    ['an unquoted token', 'x-v2', false],
    ['garbage', '%%%garbage', false],
    ['a lowercase weak prefix', 'w/"x-v2"', false],
    ['an unterminated quote', '"x-v2', false],
    ['the wildcard inside a list', '*, "a"', false],
    ['a list with one malformed member', '"x-v2", garbage', false],
    ['only commas', ' , ,', false],
    ['an empty header', '', false],
    ['a space inside the tag', '"x v2"', false],
    ['undefined', undefined, false],
  ])('S52 AS-65: %s (%s) against "x-v2" → %s', (_name, header, expected) => {
    expect(matchesIfNoneMatch(header, strong)).toBe(expected);
  });

  it.each([
    ['W/"p1-v3"', 'W/"p1-v3"', true],
    ['"p1-v3"', 'W/"p1-v3"', true], // weak comparison: strong header against a weak current tag
    ['W/"p1-v4"', 'W/"p1-v3"', false],
    ['*', 'W/"p1-v3"', true],
  ])(
    'S52 AS-65: header %s against the current tag %s → %s',
    (header, current, expected) => {
      expect(matchesIfNoneMatch(header, current)).toBe(expected);
    },
  );

  it('S52 AS-65: a malformed header is never an error', () => {
    for (const header of [
      '"',
      'W/"',
      '"\u0000"',
      '\n',
      '"a" "b"',
      ',,"',
      'W/W/"a"',
    ])
      expect(() => matchesIfNoneMatch(header, strong)).not.toThrow();
  });
});
