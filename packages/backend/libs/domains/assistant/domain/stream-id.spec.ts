import {
  compareStreamIds,
  formatStreamId,
  isStreamId,
  parseStreamId,
} from './stream-id';

describe('S46 stream ids', () => {
  it.each([
    ['1700000000000-0', true],
    ['0-1', true],
    ['12-345', true],
    ['', false],
    ['abc', false],
    ['123', false],
    ['123-', false],
    ['-5', false],
    ['1-2-3', false],
    ['1.5-2', false],
    ['1700000000000_0', false],
    [' 1-2', false],
    ['1-2 ', false],
    ['1-2\n', false],
    ['+1-2', false],
    ['0x1-2', false],
    ['1e3-2', false],
  ])('S46 AS-24: id %j well-formed=%s', (id, ok) => {
    expect(isStreamId(id)).toBe(ok);
    expect(parseStreamId(id) !== null).toBe(ok);
  });

  it('S46 AS-24: parse and format round trip, beyond Number.MAX_SAFE_INTEGER', () => {
    const id = '99999999999999999999-18446744073709551615';
    expect(formatStreamId(parseStreamId(id)!)).toBe(id);
  });

  it.each([
    ['9-0', '10-0', -1],
    ['10-0', '9-0', 1],
    ['100-0', '99-999', 1],
    ['5-9', '5-10', -1],
    ['5-10', '5-9', 1],
    ['5-1', '5-1', 0],
    ['0-0', '0-1', -1],
    ['1700000000000-2', '1700000000000-10', -1],
  ])(
    'S46 AS-22: compareStreamIds(%s, %s) is numeric, not lexical -> %s',
    (a, b, expected) => {
      expect(Math.sign(compareStreamIds(a, b))).toBe(expected);
    },
  );

  it('S46 AS-24: comparing a malformed id throws', () => {
    expect(() => compareStreamIds('x', '1-1')).toThrow();
  });
});
