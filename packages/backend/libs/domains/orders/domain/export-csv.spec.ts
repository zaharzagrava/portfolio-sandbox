import {
  CSV_BOM,
  EXPORT_HEADER,
  encodeCell,
  encodeRecord,
  neutraliseFormula,
} from './export-csv';
import type { ExportRow } from './export-row';

const row = (over: Partial<ExportRow> = {}): ExportRow => ({
  orderId: '11111111-1111-4111-8111-111111111111',
  shopOrderId: '22222222-2222-4222-8222-222222222222',
  createdAt: new Date('2026-01-02T03:04:05.006Z'),
  shopOrderStatus: 'PAID',
  currency: 'USD',
  productId: '33333333-3333-4333-8333-333333333333',
  sku: 'SKU-1',
  title: 'Widget',
  quantity: 3,
  unitPriceMinor: '1999',
  discountMinor: '0',
  lineTotalMinor: '5997',
  ...over,
});

describe('export csv encoding', () => {
  it.each([
    ['plain', 'plain'],
    ['a,b', '"a,b"'],
    ['say "x"', '"say ""x"""'],
    ['line1\nline2', '"line1\nline2"'],
    ['line1\rline2', '"line1\rline2"'],
    ['  padded  ', '  padded  '],
    ['日本語 🚀', '日本語 🚀'],
    ['', ''],
  ])('S12 AS-13: cell %j is written as %j', (input, expected) => {
    expect(encodeCell(input)).toBe(expected);
  });

  it('S12 AS-13: a 10,000-character title is kept whole', () => {
    const title = 'x'.repeat(10_000);
    expect(encodeCell(title)).toBe(title);
    expect(encodeCell(`${title},`)).toBe(`"${title},"`);
  });

  it('S12 AS-13: fields are comma separated and the record ends with CRLF', () => {
    const out = encodeRecord(row({ title: 'a,b' }));
    expect(out).toBe(
      '11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222,' +
        '2026-01-02T03:04:05.006Z,PAID,USD,33333333-3333-4333-8333-333333333333,' +
        'SKU-1,"a,b",3,1999,0,5997\r\n',
    );
  });

  it('S12 AS-13: the same input always yields the same bytes', () => {
    const a = Buffer.from(encodeRecord(row({ title: '日本語 "q"' })));
    const b = Buffer.from(encodeRecord(row({ title: '日本語 "q"' })));
    expect(a.equals(b)).toBe(true);
  });

  it('S12 AS-13: a null sku is an empty cell', () => {
    expect(encodeRecord(row({ sku: null }))).toContain(',,Widget,');
  });

  it('S12 AS-13: BOM and exact header constant', () => {
    expect(CSV_BOM).toBe('﻿');
    expect(EXPORT_HEADER).toBe(
      'order_id,shop_order_id,created_at,shop_order_status,currency,product_id,sku,title,quantity,unit_price_minor,discount_minor,line_total_minor\r\n',
    );
  });

  it.each([
    ['=HYPERLINK("http://x")', `"'=HYPERLINK(""http://x"")"`],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@sum', "'@sum"],
    ['\tTab', "'\tTab"],
    ['\rCR', `"'\rCR"`],
  ])('S12 AS-14: title %j gets one apostrophe -> %j', (title, expected) => {
    expect(encodeRecord(row({ title, sku: 'S' }))).toContain(
      `,S,${expected},3,`,
    );
    expect(neutraliseFormula(title)).toBe(`'${title}`);
  });

  it('S12 AS-14: sku is guarded too', () => {
    expect(encodeRecord(row({ sku: '=1+1' }))).toContain(",'=1+1,Widget,");
  });

  it.each(['plain', "'quoted", ' =space first', '1=1', ''])(
    'S12 AS-14: neutral start %j is unchanged',
    (title) => {
      expect(neutraliseFormula(title)).toBe(title);
    },
  );

  it('S12 AS-14: numeric columns and IDs are never modified', () => {
    const out = encodeRecord(
      row({ unitPriceMinor: '-5', discountMinor: '-0', lineTotalMinor: '-15' }),
    );
    expect(out.endsWith(',3,-5,-0,-15\r\n')).toBe(true);
  });
});
