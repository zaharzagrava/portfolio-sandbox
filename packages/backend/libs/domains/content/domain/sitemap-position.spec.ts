import {
  MAX_URLS_PER_FILE,
  lastPage,
  pageOfPosition,
  pageRange,
  parsePageNumber,
} from './sitemap-position';

describe('S27 sitemap positions', () => {
  it.each([
    [1, 2, 0],
    [2, 2, 0],
    [3, 2, 1],
    [4, 2, 1],
    [5, 2, 2],
    [6, 2, 2],
    [2500, 2500, 0],
    [2501, 2500, 1],
    [5001, 2500, 2],
  ])(
    'S27 AS-72: position %i at capacity %i is on page %i',
    (position, capacity, page) => {
      expect(pageOfPosition(position, capacity)).toBe(page);
    },
  );

  it('S27 AS-72: a page covers a stable position range', () => {
    expect(pageRange(0, 2)).toEqual({ from: 1, to: 2 });
    expect(pageRange(1, 2)).toEqual({ from: 3, to: 4 });
    expect(pageRange(2, 2500)).toEqual({ from: 5001, to: 7500 });
  });

  it('S27 AS-70: the last page follows the highest position, one empty page without any', () => {
    expect(lastPage(5001, 2500)).toBe(2);
    expect(lastPage(5000, 2500)).toBe(1);
    expect(lastPage(1, 2500)).toBe(0);
    expect(lastPage(null, 2500)).toBe(0);
    expect(lastPage(0, 2500)).toBe(0);
  });

  it.each([
    ['0', 0],
    ['1', 1],
    ['17', 17],
    ['999999999', 999_999_999],
  ])('S27 AS-73: page %j is %i', (text, page) => {
    expect(parsePageNumber(text)).toBe(page);
  });

  it.each([
    'abc',
    '-1',
    '1.5',
    '99999999999999999999',
    '1000000000',
    '',
    '007',
    '00',
    ' 1',
    '1 ',
    '1e3',
    '+1',
    '0x10',
  ])('S27 AS-73: page %j is not a page number', (text) => {
    expect(parsePageNumber(text)).toBeNull();
  });

  it('S27 AS-71: the default capacity at 20 locales never exceeds the 50,000 URL limit', () => {
    expect(MAX_URLS_PER_FILE).toBe(50_000);
    expect(2500 * 20).toBeLessThanOrEqual(MAX_URLS_PER_FILE);
  });
});
