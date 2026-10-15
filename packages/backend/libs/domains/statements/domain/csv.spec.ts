import { csvInteger, csvRow, csvText, CSV_HEADER } from './csv';

describe('S16 AS-64 CSV cells', () => {
  it.each([
    ['=HYPERLINK("http://evil")', '"\'=HYPERLINK(""http://evil"")"'],
    ['+1+1', '"\'+1+1"'],
    ['-2+3', '"\'-2+3"'],
    ['@SUM(A1)', '"\'@SUM(A1)"'],
    ['\tcmd', '"\'\tcmd"'],
    ['\rcmd', '"\'\rcmd"'],
    ['plain', 'plain'],
    ['with,comma', '"with,comma"'],
    ['say "hi"', '"say ""hi"""'],
    ['two\nlines', '"two\nlines"'],
    ['', ''],
  ])('S16 AS-64: text %j is written as %j', (value, written) => {
    expect(csvText(value)).toBe(written);
  });

  it('S16 AS-64: a null text cell is empty', () => {
    expect(csvText(null)).toBe('');
  });

  it.each([
    [-900, '-900'],
    [0, '0'],
    [30500, '30500'],
    [null, ''],
  ])('S16 AS-64: the integer %p stays bare as %j', (value, written) => {
    expect(csvInteger(value)).toBe(written);
  });

  it('S16 AS-64: a non-integer in an integer column is refused, not written as a formula', () => {
    expect(() => csvInteger(1.5)).toThrow();
    expect(() => csvInteger(Number.NaN)).toThrow();
  });

  it('S16 AS-61: a row ends with CRLF and the header names the 14 columns', () => {
    expect(CSV_HEADER).toBe(
      'rowType,orderId,lineId,paidAt,productId,category,quantity,unitPriceMinor,lineTotalMinor,rateBps,commissionMinor,refersToMonth,bookedMonth,cause\r\n',
    );
    expect(csvRow(['a', '-900', ''])).toBe('a,-900,\r\n');
  });
});
