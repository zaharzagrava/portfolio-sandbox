import { checkSlug, RESERVED_SLUGS } from './slug-policy';

describe('S03 slug policy', () => {
  it.each([
    ['abc', 'ok'],
    ['my-shop-42', 'ok'],
    ['a'.repeat(40), 'ok'],
    ['ab', 'invalid'],
    ['a'.repeat(41), 'invalid'],
    ['Upper', 'invalid'],
    ['with space', 'invalid'],
    ['under_score', 'invalid'],
    ['ünï', 'invalid'],
    ['', 'invalid'],
    ['-start', 'invalid'],
    ['end-', 'invalid'],
    ['seller-42', 'reserved'],
    ['my-sandbox', 'reserved'],
    ['admin', 'reserved'],
    ['api', 'reserved'],
    ['www', 'reserved'],
  ] as const)('%j -> %s', (slug, expected) => {
    expect(checkSlug(slug)).toBe(expected);
  });

  it('keeps the tombstone prefix reserved', () => {
    expect(checkSlug('deleted-123')).toBe('reserved');
    expect(RESERVED_SLUGS.has('admin')).toBe(true);
  });
});
