import * as fc from 'fast-check';
import { parse } from 'csv-parse/sync';
import {
  REPORT_CODES,
  REPORT_HEADER,
  guardCell,
  messageFor,
  reportLines,
} from './error-report';

describe('S07 import error report', () => {
  it('S07 AS-47: the header is row,sku,field,code,message', () => {
    expect(REPORT_HEADER).toBe('row,sku,field,code,message');
  });

  it.each([
    ['=HYPERLINK("http://x","y")', `'=HYPERLINK("http://x","y")`],
    ['+1', `'+1`],
    ['-1', `'-1`],
    ['@SUM(A1)', `'@SUM(A1)`],
    ['\tx', `'\tx`],
    ['\rx', `'\rx`],
    ['a=1', 'a=1'],
    ['x+y', 'x+y'],
    ['plain', 'plain'],
    ['', ''],
  ])('S07 AS-30: guard of %j is %j', (input, expected) => {
    expect(guardCell(input)).toBe(expected);
  });

  it('S07 AS-30: a formula in the sku is written with a leading apostrophe and CSV-escaped', () => {
    const [line] = reportLines({
      row: 3,
      sku: '=HYPERLINK("http://x","y")',
      problems: [{ field: 'title', code: 'missing_required' }],
    });
    const [record] = parse(line, { relax_column_count: true }) as string[][];
    expect(record[0]).toBe('3');
    expect(record[1]).toBe(`'=HYPERLINK("http://x","y")`);
    expect(record.slice(2, 4)).toEqual(['title', 'missing_required']);
  });

  it('S07 AS-47: one line per problem, in the order given', () => {
    const lines = reportLines({
      row: 17,
      sku: 'SKU-17',
      problems: [
        { field: 'title', code: 'missing_required' },
        { field: 'price', code: 'invalid_price' },
      ],
    });
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith('17,SKU-17,title,missing_required,')).toBe(true);
    expect(lines[1].startsWith('17,SKU-17,price,invalid_price,')).toBe(true);
    expect(lines.every((l) => l.endsWith('\n'))).toBe(true);
  });

  it('S07 AS-30: values round-trip through CSV apart from the guard (property)', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        fc.integer({ min: 1, max: 1e6 }),
        (sku, row) => {
          const text = reportLines({
            row,
            sku,
            problems: [{ field: 'title', code: 'missing_required' }],
          }).join('');
          const records = parse(text, {
            relax_column_count: true,
            skip_empty_lines: false,
          }) as string[][];
          expect(records).toHaveLength(1);
          expect(records[0][0]).toBe(String(row));
          // the cell is the original, with at most one leading apostrophe added by the guard
          const cell = records[0][1];
          expect(cell === sku || cell === `'${sku}`).toBe(true);
          if (!/^[=+\-@\t\r]/.test(sku)) expect(cell).toBe(sku);
          else expect(cell).toBe(`'${sku}`);
        },
      ),
    );
  });

  it('S07 AS-48: every report code has a message; an unknown code still prints a generic one', () => {
    for (const code of REPORT_CODES)
      expect(messageFor(code, 'title').length).toBeGreaterThan(10);
    expect(messageFor('some_new_catalog_code', 'title')).toMatch(/refused/i);
  });

  it('S07 AS-48: catalog refusals keep their code and are mapped back to the column name', () => {
    const [line] = reportLines({
      row: 4,
      sku: 'S4',
      problems: [{ field: 'priceMinor', code: 'invalid' }],
    });
    expect(line.startsWith('4,S4,price,invalid,')).toBe(true);
    const [other] = reportLines({
      row: 5,
      sku: 'S5',
      problems: [{ field: 'externalSku', code: 'invalid' }],
    });
    expect(other.startsWith('5,S5,sku,invalid,')).toBe(true);
    const [qty] = reportLines({
      row: 6,
      sku: 'S6',
      problems: [{ field: 'quantity', code: 'invalid' }],
    });
    expect(qty.startsWith('6,S6,stock,invalid,')).toBe(true);
  });

  it('S07 AS-28: an oversize record has an empty field and the row_too_large code', () => {
    const [line] = reportLines({
      row: 9,
      sku: '',
      problems: [{ field: '', code: 'row_too_large' }],
    });
    expect(line.startsWith('9,,,row_too_large,')).toBe(true);
  });

  it('S07 AS-47: quotes, commas and newlines in the sku are escaped', () => {
    const [line] = reportLines({
      row: 1,
      sku: 'a,"b"\nc',
      problems: [{ field: 'title', code: 'missing_required' }],
    });
    const [record] = parse(line, { relax_column_count: true }) as string[][];
    expect(record[1]).toBe('a,"b"\nc');
  });
});
