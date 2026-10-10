import {
  normalizeTags,
  parseCreateInput,
  parseUpdateInput,
} from './product-input';

const valid = {
  title: 'Wool coat',
  description: 'Warm',
  brand: 'Nord',
  category: 'coats',
  priceMinor: 12_900,
  quantity: 5,
};

const fieldsOf = (result: ReturnType<typeof parseCreateInput>) =>
  result.ok ? [] : result.fields;

describe('S05 AS-01: tag normalisation', () => {
  it.each([
    [
      [' Winter ', 'winter', 'Wool'],
      ['winter', 'wool'],
    ],
    [
      ['B', 'a', 'b', 'A'],
      ['b', 'a'],
    ],
    [[], []],
    [['ÄB', 'äb'], ['äb']],
    [['x'.repeat(50)], ['x'.repeat(50)]],
    [['😀'.repeat(50)], ['😀'.repeat(50)]],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeTags(input)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ['empty tag', ['']],
    ['whitespace tag', ['   ']],
    ['51 characters', ['x'.repeat(51)]],
    ['51 code points of 4 bytes', ['😀'.repeat(51)]],
    ['33 distinct tags', Array.from({ length: 33 }, (_, i) => `t${i}`)],
    ['non-string tag', [1]],
  ])('refuses %s', (_name, input) => {
    expect(normalizeTags(input as unknown[]).ok).toBe(false);
  });

  it('counts the 32-tag limit before de-duplication', () => {
    expect(normalizeTags(Array.from({ length: 33 }, () => 'same')).ok).toBe(
      false,
    );
  });
});

describe('S05 AS-02: create input limits', () => {
  it('accepts a valid body and normalises it', () => {
    const result = parseCreateInput({
      ...valid,
      title: '  Wool coat ',
      tags: [' Winter ', 'winter', 'Wool'],
    });
    expect(result).toEqual({
      ok: true,
      value: { ...valid, tags: ['winter', 'wool'] },
    });
  });

  it.each([
    ['title missing', { title: undefined }, 'title'],
    ['title empty', { title: '' }, 'title'],
    ['title whitespace', { title: '   ' }, 'title'],
    ['title 201 code points', { title: 'x'.repeat(201) }, 'title'],
    ['description 4001', { description: 'x'.repeat(4_001) }, 'description'],
    ['brand missing', { brand: undefined }, 'brand'],
    ['brand 101', { brand: 'x'.repeat(101) }, 'brand'],
    ['category empty', { category: '' }, 'category'],
    ['category 101', { category: 'x'.repeat(101) }, 'category'],
    ['priceMinor missing', { priceMinor: undefined }, 'priceMinor'],
    ['priceMinor fractional', { priceMinor: 12.5 }, 'priceMinor'],
    ['priceMinor string', { priceMinor: '100' }, 'priceMinor'],
    ['priceMinor zero', { priceMinor: 0 }, 'priceMinor'],
    ['priceMinor negative', { priceMinor: -1 }, 'priceMinor'],
    ['priceMinor above max', { priceMinor: 10_000_000_001 }, 'priceMinor'],
    ['quantity negative', { quantity: -1 }, 'quantity'],
    ['quantity fractional', { quantity: 1.5 }, 'quantity'],
    ['quantity above max', { quantity: 1_000_000_001 }, 'quantity'],
    ['non-string tag', { tags: [1] }, 'tags'],
    ['empty tag', { tags: [''] }, 'tags'],
    ['rating', { rating: 5 }, 'rating'],
    ['shopId', { shopId: 'x' }, 'shopId'],
    ['id', { id: 'x' }, 'id'],
    ['status', { status: 'ARCHIVED' }, 'status'],
    ['version', { version: 3 }, 'version'],
    ['viewCount', { viewCount: 3 }, 'viewCount'],
    ['sellerId', { sellerId: 'x' }, 'sellerId'],
    ['createdBy', { createdBy: 'x' }, 'createdBy'],
    ['isSandbox', { isSandbox: true }, 'isSandbox'],
    ['externalSku', { externalSku: 'x' }, 'externalSku'],
  ])('refuses %s and names the field', (_name, patch, field) => {
    const result = parseCreateInput({ ...valid, ...patch });
    expect(fieldsOf(result)).toContain(field);
  });

  it('counts code points, not UTF-16 units', () => {
    expect(parseCreateInput({ ...valid, title: '😀'.repeat(200) }).ok).toBe(
      true,
    );
    expect(parseCreateInput({ ...valid, title: '😀'.repeat(201) }).ok).toBe(
      false,
    );
    expect(
      parseCreateInput({ ...valid, description: '😀'.repeat(4_000) }).ok,
    ).toBe(true);
  });

  it('accepts the boundary values', () => {
    expect(
      parseCreateInput({
        ...valid,
        title: 'x'.repeat(200),
        priceMinor: 10_000_000_000,
        quantity: 1_000_000_000,
        tags: Array.from({ length: 32 }, (_, i) => `t${i}`),
      }).ok,
    ).toBe(true);
    expect(parseCreateInput({ ...valid, priceMinor: 1, quantity: 0 }).ok).toBe(
      true,
    );
  });

  it('refuses a body that is not an object', () => {
    expect(parseCreateInput(null).ok).toBe(false);
    expect(parseCreateInput([]).ok).toBe(false);
  });
});

describe('S05 AS-08: update input', () => {
  it('needs a positive integer expectedVersion and one field to change', () => {
    expect(parseUpdateInput({ expectedVersion: 3, title: 'New' })).toEqual({
      ok: true,
      value: { expectedVersion: 3, title: 'New' },
    });
    for (const body of [
      { title: 'New' },
      { expectedVersion: 0, title: 'New' },
      { expectedVersion: 1.5, title: 'New' },
      { expectedVersion: '3', title: 'New' },
      { expectedVersion: 3 },
      { expectedVersion: 3, title: null },
      { expectedVersion: 3, id: 'x' },
      { expectedVersion: 3, status: 'ARCHIVED' },
      { expectedVersion: 3, externalSku: 'x' },
      { expectedVersion: 3, priceMinor: 0 },
    ])
      expect(parseUpdateInput(body).ok).toBe(false);
  });
});
