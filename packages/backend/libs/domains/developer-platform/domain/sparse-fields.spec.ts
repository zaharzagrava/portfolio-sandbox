import { parseExpand, parseFields } from './sparse-fields';

const PRODUCT_V2 = ['id', 'object', 'title', 'price', 'stock', 'brand'];
const PRODUCT_V1 = ['id', 'object', 'title', 'price', 'quantity', 'brand'];

describe('S42 sparse fields (FR-027, FR-037)', () => {
  it('returns null for an absent parameter', () => {
    expect(parseFields(undefined, PRODUCT_V2)).toBeNull();
  });

  it.each<[string, string[], string[]]>([
    ['id,title', PRODUCT_V2, ['id', 'title']],
    [' id , price ', PRODUCT_V2, ['id', 'price']],
    ['stock', PRODUCT_V2, ['stock']],
    ['quantity', PRODUCT_V1, ['quantity']],
    ['id,id', PRODUCT_V2, ['id']],
  ])('parses %s', (raw, allowed, expected) => {
    expect(parseFields(raw, allowed)).toEqual(expected);
  });

  it('uses the names of the requested version: stock is unknown at 2026-01-15', () => {
    expect(() => parseFields('stock', PRODUCT_V1)).toThrow(
      expect.objectContaining({ code: 'invalid_fields' }),
    );
  });

  it.each(['', 'nope', 'id,,title', 'a.b'])('refuses %p', (raw) => {
    expect(() => parseFields(raw, PRODUCT_V2)).toThrow(
      expect.objectContaining({ code: 'invalid_fields' }),
    );
  });

  it('expand accepts only shop', () => {
    expect(parseExpand(undefined)).toEqual([]);
    expect(parseExpand('shop')).toEqual(['shop']);
    expect(parseExpand('shop,shop')).toEqual(['shop']);
  });

  it.each(['buyer', 'shop.owner', 'shop,buyer', ''])(
    'refuses expand %p',
    (raw) => {
      expect(() => parseExpand(raw)).toThrow(
        expect.objectContaining({ code: 'invalid_expand' }),
      );
    },
  );

  it('refuses more than 3 values', () => {
    expect(() => parseExpand('shop,a,b,c')).toThrow(
      expect.objectContaining({ code: 'invalid_expand' }),
    );
  });
});
