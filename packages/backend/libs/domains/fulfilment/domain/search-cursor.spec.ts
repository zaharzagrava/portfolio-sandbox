import { decodeCursor, encodeCursor, queryKey } from './search-cursor';

describe('S19 AS-05 search cursor', () => {
  const key = queryKey({ q: 'airpods', lat: 52.5, lng: 13.4, radiusKm: 5 });

  it('round-trips a sort tuple', () => {
    const tuple = [1.5, 3012.4, '0190c6a0-0000-7000-8000-000000000001'];
    expect(decodeCursor(encodeCursor(tuple, key), key)).toEqual(tuple);
  });

  it('is opaque: not a bare number and not base64 of one', () => {
    const cursor = encodeCursor([20], key);
    expect(cursor).not.toMatch(/^\d+$/);
    expect(Buffer.from(cursor, 'base64url').toString()).not.toMatch(/^\d+$/);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses a cursor made for another query', () => {
    const other = queryKey({ q: 'case', lat: 52.5, lng: 13.4, radiusKm: 5 });
    expect(decodeCursor(encodeCursor([1], key), other)).toBeNull();
  });

  it('refuses a changed tuple', () => {
    const body = JSON.parse(
      Buffer.from(encodeCursor([1, 'a'], key), 'base64url').toString(),
    );
    body.t = [999, 'a'];
    const forged = Buffer.from(JSON.stringify(body)).toString('base64url');
    expect(decodeCursor(forged, key)).toBeNull();
  });

  it.each([
    ['text', 'not-a-cursor'],
    ['empty', ''],
    ['json that is not a cursor', Buffer.from('{"a":1}').toString('base64url')],
    ['an array', Buffer.from('[1,2]').toString('base64url')],
    ['a number', '12345'],
  ])('refuses %s', (_name, cursor) => {
    expect(decodeCursor(cursor, key)).toBeNull();
  });

  it('builds the same key for the same query whatever the property order', () => {
    expect(queryKey({ a: 1, b: 2 })).toBe(queryKey({ b: 2, a: 1 }));
    expect(queryKey({ a: 1 })).not.toBe(queryKey({ a: 2 }));
  });
});
