import * as fc from 'fast-check';
import {
  DEFAULT_BRAND,
  catalogFieldToColumn,
  checkHeader,
  normaliseColumns,
  parsePriceMinor,
  parseRecord,
  parseStock,
  parseTags,
} from './import-row';

describe('S07 import row coercion', () => {
  it.each([
    ['12.99', 1299],
    ['0.1', 10],
    ['19', 1900],
    [' 12.99 ', 1299],
    ['0.00', 0],
    ['0', 0],
    [19.99, 1999],
    [0, 0],
    ['999999999.99', 99_999_999_999],
  ])('S07 AS-15: price %j -> %j minor units', (input, minor) => {
    expect(parsePriceMinor(input)).toEqual({ ok: true, minor });
  });

  it.each([
    ['12.999', 'invalid_price'],
    ['-5', 'invalid_price'],
    ['12,99', 'invalid_price'],
    ['1e3', 'invalid_price'],
    ['1 299.00', 'invalid_price'],
    ['abc', 'invalid_price'],
    ['true', 'invalid_price'],
    ['1234567890', 'invalid_price'],
    [-1, 'invalid_price'],
    [1e21, 'invalid_price'],
    [Number.NaN, 'invalid_price'],
    ['', 'missing_required'],
    [' ', 'missing_required'],
    [undefined, 'missing_required'],
    [null, 'missing_required'],
    [true, 'invalid_type'],
    [{}, 'invalid_type'],
    [[], 'invalid_type'],
  ])('S07 AS-15: price %j is refused as %s', (input, code) => {
    expect(parsePriceMinor(input)).toEqual({ ok: false, code });
  });

  it('S07 AS-15: any whole part up to 999,999,999 and any cents parse exactly (no floating point)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999_999_999 }),
        fc.integer({ min: 0, max: 99 }),
        (whole, cents) => {
          const text = `${whole}.${String(cents).padStart(2, '0')}`;
          expect(parsePriceMinor(text)).toEqual({
            ok: true,
            minor: whole * 100 + cents,
          });
        },
      ),
    );
  });

  it.each([
    ['3', 3],
    ['0', 0],
    [' 7 ', 7],
    ['1000000', 1_000_000],
    [4, 4],
    [0, 0],
  ])('S07 AS-15: stock %j -> %j', (input, quantity) => {
    expect(parseStock(input)).toEqual({ ok: true, quantity });
  });

  it.each([[''], ['  '], [undefined], [null]])(
    'S07 AS-20: an empty stock %j means "do not touch stock"',
    (input) => {
      expect(parseStock(input)).toEqual({ ok: true, quantity: undefined });
    },
  );

  it.each([
    ['-1'],
    ['1.5'],
    ['1e3'],
    ['abc'],
    ['1000001'],
    [-1],
    [1.5],
    [1_000_001],
  ])('S07 AS-15: stock %j is invalid_stock', (input) => {
    expect(parseStock(input)).toEqual({ ok: false, code: 'invalid_stock' });
  });

  it('S07 AS-15: stock of another JSON type is invalid_type', () => {
    expect(parseStock(true)).toEqual({ ok: false, code: 'invalid_type' });
    expect(parseStock({})).toEqual({ ok: false, code: 'invalid_type' });
  });

  it.each([
    ['a|b| c ', ['a', 'b', 'c']],
    ['', []],
    ['|||', []],
    [
      ['x', ' y '],
      ['x', 'y'],
    ],
  ])('S07 AS-15: tags %j -> %j', (input, tags) => {
    expect(parseTags(input)).toEqual(tags);
  });

  it('S07 AS-14: a record maps to the catalog item field names', () => {
    expect(
      parseRecord({
        sku: ' A1 ',
        title: 'Cable',
        description: 'two metres',
        brand: 'Anker',
        category: 'cables',
        price: '12.99',
        stock: '5',
        tags: 'a|b',
      }),
    ).toEqual({
      ok: true,
      item: {
        externalSku: 'A1',
        title: 'Cable',
        description: 'two metres',
        brand: 'Anker',
        category: 'cables',
        priceMinor: 1299,
        quantity: 5,
        tags: ['a', 'b'],
      },
    });
  });

  it('S07 AS-14: optional columns may be absent; brand falls back to the default, stock and tags are left out', () => {
    const result = parseRecord({
      sku: 'A1',
      title: 'Cable',
      category: 'cables',
      price: '1',
    });
    expect(result).toEqual({
      ok: true,
      item: {
        externalSku: 'A1',
        title: 'Cable',
        category: 'cables',
        brand: DEFAULT_BRAND,
        priceMinor: 100,
      },
    });
  });

  it('S07 AS-20: an empty stock cell carries no quantity, 0 sets 0', () => {
    const base = { sku: 'A1', title: 'T', category: 'c', price: '1' };
    const empty = parseRecord({ ...base, stock: '' });
    const zero = parseRecord({ ...base, stock: '0' });
    expect(empty.ok && 'quantity' in empty.item).toBe(false);
    expect(zero.ok && zero.item.quantity).toBe(0);
  });

  it('S07 AS-47: every problem of a record is reported, with the file column name', () => {
    expect(
      parseRecord({
        sku: 'A1',
        title: '',
        category: 'c',
        price: 'abc',
        stock: '-1',
      }),
    ).toEqual({
      ok: false,
      problems: [
        { field: 'title', code: 'missing_required' },
        { field: 'price', code: 'invalid_price' },
        { field: 'stock', code: 'invalid_stock' },
      ],
    });
  });

  it('S07 AS-15: a JSON value of the wrong type for a text column is invalid_type', () => {
    expect(
      parseRecord({ sku: 5, title: 'T', category: 'c', price: '1' }),
    ).toEqual({
      ok: false,
      problems: [{ field: 'sku', code: 'invalid_type' }],
    });
  });

  it('S07 AS-48: catalog field names map back to the file column names', () => {
    expect(catalogFieldToColumn('priceMinor')).toBe('price');
    expect(catalogFieldToColumn('quantity')).toBe('stock');
    expect(catalogFieldToColumn('externalSku')).toBe('sku');
    expect(catalogFieldToColumn('title')).toBe('title');
    expect(catalogFieldToColumn('tags')).toBe('tags');
  });

  it('S07 AS-14: headers are matched case-insensitively after trimming', () => {
    expect(normaliseColumns([' SKU ', 'Title', 'PRICE', 'Category'])).toEqual([
      'sku',
      'title',
      'price',
      'category',
    ]);
  });

  it.each([
    [['sku', 'title', 'price', 'category'], { ok: true, ignored: [] }],
    [
      ['sku', 'title', 'price', 'category', 'colour', 'stock'],
      { ok: true, ignored: ['colour'] },
    ],
    [
      ['sku', 'title', 'category'],
      { ok: false, missing: ['price'], repeated: [] },
    ],
    [
      ['sku', 'title', 'price', 'price', 'category'],
      { ok: false, missing: [], repeated: ['price'] },
    ],
    [
      [],
      {
        ok: false,
        missing: ['sku', 'title', 'price', 'category'],
        repeated: [],
      },
    ],
  ])('S07 AS-16: header %j -> %j', (columns, expected) => {
    expect(checkHeader(columns)).toEqual(expected);
  });
});
