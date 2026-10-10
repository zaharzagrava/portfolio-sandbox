import { decodeCursor, encodeCursor, parseLimit } from './cursor';

describe('S03 cursor', () => {
  it('round-trips an opaque key', () => {
    const key = [
      '2026-01-01T00:00:00.000Z',
      'f3a9e2b0-0000-4000-8000-000000000001',
    ];
    const cursor = encodeCursor(key);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, 2)).toEqual(key);
  });

  it.each([
    'not-base64!!',
    Buffer.from('{"a":1}').toString('base64url'),
    Buffer.from('["only-one"]').toString('base64url'),
    Buffer.from('[1,2]').toString('base64url'),
    '',
  ])('rejects the tampered cursor %j', (cursor) => {
    expect(decodeCursor(cursor, 2)).toBeNull();
  });

  it.each([
    [undefined, 50],
    ['1', 1],
    ['100', 100],
  ] as const)('limit %j -> %i', (raw, expected) => {
    expect(parseLimit(raw)).toBe(expected);
  });

  it.each(['0', '101', '-1', 'abc', '1.5'])('rejects limit %j', (raw) => {
    expect(parseLimit(raw)).toBeNull();
  });
});
