import {
  decodeSearchCursor,
  encodeSearchCursor,
  searchFingerprint,
  type SearchScope,
} from './search-cursor';
import { InvalidCursorError } from './search-errors';

const SORTS = ['relevance', 'price-asc', 'price-desc', 'newest', 'browse'];
const ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

const scope = (over: Partial<SearchScope> = {}): SearchScope => ({
  q: 'espresso machine',
  filters: { category: 'kitchen', inStock: true },
  sort: 'relevance',
  mode: 'lexical',
  ...over,
});

const repack = (cursor: string, edit: (v: unknown[]) => unknown) =>
  Buffer.from(
    JSON.stringify(
      edit(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))),
    ),
  ).toString('base64url');

describe('search cursor codec (S32 AS-84)', () => {
  it.each(SORTS)('S32 AS-84: round trips for sort %s', (sort) => {
    const fp = searchFingerprint(scope({ sort }));
    const sv = sort === 'relevance' ? [12.5, 'x'] : [1999, 1700000000000];
    const cursor = encodeSearchCursor({ sv, id: ID }, fp);
    expect(decodeSearchCursor(cursor, fp)).toEqual({ sv, id: ID });
  });

  it('S32 AS-84: is opaque base64url without readable field names', () => {
    const cursor = encodeSearchCursor(
      { sv: [1999], id: ID },
      searchFingerprint(scope()),
    );
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    for (const word of ['sv', '"id"', 'fp', 'products', 'index', '_m'])
      expect(raw).not.toContain(word);
    expect(cursor).not.toContain(ID);
  });

  it('S32 AS-84: the fingerprint binds (q, filters, sort, mode) and ignores filter key order', () => {
    const base = searchFingerprint(scope());
    expect(searchFingerprint(scope({ q: 'other' }))).not.toBe(base);
    expect(searchFingerprint(scope({ sort: 'newest' }))).not.toBe(base);
    expect(searchFingerprint(scope({ mode: 'semantic' }))).not.toBe(base);
    expect(
      searchFingerprint(scope({ filters: { category: 'kitchen' } })),
    ).not.toBe(base);
    expect(
      searchFingerprint(scope({ filters: { inStock: true, category: 'kitchen' } })),
    ).toBe(base);
    expect(searchFingerprint(scope({ q: null }))).not.toBe(base);
  });

  it('S32 AS-84: another fingerprint is refused with InvalidCursorError (invalid_cursor)', () => {
    const cursor = encodeSearchCursor(
      { sv: [1], id: ID },
      searchFingerprint(scope()),
    );
    const other = searchFingerprint(scope({ sort: 'price-asc' }));
    expect(() => decodeSearchCursor(cursor, other)).toThrow(InvalidCursorError);
    try {
      decodeSearchCursor(cursor, other);
    } catch (e) {
      expect((e as InvalidCursorError).code).toBe('invalid_cursor');
      expect((e as InvalidCursorError).status).toBe(422);
    }
  });

  it('S32 AS-84: altered bytes are refused', () => {
    const fp = searchFingerprint(scope());
    const cursor = encodeSearchCursor({ sv: [1999], id: ID }, fp);
    for (let i = 0; i < cursor.length; i += 3) {
      const swapped = cursor[i] === 'A' ? 'B' : 'A';
      const tampered = cursor.slice(0, i) + swapped + cursor.slice(i + 1);
      expect(() => decodeSearchCursor(tampered, fp)).toThrow(InvalidCursorError);
    }
  });

  it('S32 AS-84: a consistent edit of the sort values is refused (checksum)', () => {
    const fp = searchFingerprint(scope());
    const cursor = encodeSearchCursor({ sv: [1999], id: ID }, fp);
    const forged = repack(cursor, (v) => [[1], ...v.slice(1)]);
    expect(() => decodeSearchCursor(forged, fp)).toThrow(InvalidCursorError);
  });

  it.each([
    ['empty', ''],
    ['not base64url', '***'],
    ['not json', Buffer.from('hello').toString('base64url')],
    ['json object', Buffer.from('{"sv":[1],"id":"x","fp":"y"}').toString('base64url')],
    ['wrong length', Buffer.from('[[1],"a"]').toString('base64url')],
    ['too long', 'A'.repeat(2000)],
  ])('S32 AS-84: garbage (%s) is refused', (_n, garbage) => {
    expect(() =>
      decodeSearchCursor(garbage, searchFingerprint(scope())),
    ).toThrow(InvalidCursorError);
  });

  it('S32 AS-84: wrong types inside a well-formed cursor are refused', () => {
    const fp = searchFingerprint(scope());
    const cursor = encodeSearchCursor({ sv: [1], id: ID }, fp);
    for (const edit of [
      (v: unknown[]) => [...v.slice(0, 1), 42, ...v.slice(2)],
      (v: unknown[]) => ['x', ...v.slice(1)],
      (v: unknown[]) => [[{}], ...v.slice(1)],
      (v: unknown[]) => [...v, 'extra'],
      (v: unknown[]) => v.slice(0, 3),
    ])
      expect(() => decodeSearchCursor(repack(cursor, edit), fp)).toThrow(
        InvalidCursorError,
      );
  });

  it('S32 AS-84: refuses to encode a position that decoding would reject', () => {
    const fp = searchFingerprint(scope());
    expect(() => encodeSearchCursor({ sv: [], id: ID }, fp)).toThrow();
    expect(() => encodeSearchCursor({ sv: [1], id: '' }, fp)).toThrow();
  });
});
