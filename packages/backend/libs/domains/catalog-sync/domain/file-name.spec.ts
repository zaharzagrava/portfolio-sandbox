import { errorReportDownloadName, sanitiseFileName } from './file-name';

describe('S07 import file names', () => {
  it.each([
    ['catalog.csv', 'catalog.csv'],
    ['  catalog.csv  ', 'catalog.csv'],
    ['my catalog (final).csv', 'my catalog (final).csv'],
    ['a\r\nSet-Cookie: x', 'aSet-Cookie: x'],
    ['..\\..\\x.csv', 'x.csv'],
    ['../../etc/passwd.csv', 'etcpasswd.csv'],
    ['say "hi".csv', 'say hi.csv'],
    ["it's.csv", 'its.csv'],
    ['....', 'catalog'],
    ['.', 'catalog'],
    ['', 'catalog'],
    ['   ', 'catalog'],
    ['\u0000\u0007\u007f', 'catalog'],
    ['///', 'catalog'],
    ['Käse €.csv', 'Käse €.csv'],
  ])('S07 AS-31: %j is shown as %j', (input, expected) => {
    expect(sanitiseFileName(input)).toBe(expected);
  });

  it('S07 AS-31: 300 characters are cut to 120', () => {
    const out = sanitiseFileName('a'.repeat(300));
    expect(out).toBe('a'.repeat(120));
  });

  it('S07 AS-31: the cut never splits a surrogate pair', () => {
    const out = sanitiseFileName('😀'.repeat(200));
    expect([...out]).toHaveLength(120);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('S07 AS-31: the result never contains a control character, a separator or a quote', () => {
    for (const input of ['a\r\nb', 'x y', 'p/q\\r', 'q"r', 'a\tb']) {
      const out = sanitiseFileName(input);
      expect(/["/\\]/.test(out)).toBe(false);
      expect(
        [...out].some((c) => c.charCodeAt(0) <= 0x1f || c === '\x7f'),
      ).toBe(false);
    }
  });

  it('S07 AS-29: the download name is errors-<name>.csv without doubling the extension, within 120 characters', () => {
    expect(errorReportDownloadName('catalog.csv')).toBe('errors-catalog.csv');
    expect(errorReportDownloadName('catalog.jsonl')).toBe('errors-catalog.csv');
    expect(errorReportDownloadName('catalog')).toBe('errors-catalog.csv');
    expect(
      errorReportDownloadName('a'.repeat(300) + '.csv').length,
    ).toBeLessThanOrEqual(120);
    expect(errorReportDownloadName('a\r\nSet-Cookie: x.csv')).not.toMatch(
      /[\r\n]/,
    );
  });
});
