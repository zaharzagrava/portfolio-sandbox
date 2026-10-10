import { decodeCursor, encodeCursor } from './job-cursor';
import { InvalidCursorError } from './job-errors';

const position = {
  createdAt: '2026-10-09 10:00:00.123456+00',
  id: '0199a000-0000-7000-8000-000000000001',
};

const flip = (cursor: string) =>
  cursor.slice(0, 5) + (cursor[5] === 'A' ? 'B' : 'A') + cursor.slice(6);

describe('job list cursor (S49)', () => {
  it('S49 AS-82: round-trips createdAt and id', () => {
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it('S49 AS-82: is URL safe', () => {
    expect(encodeCursor(position)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['empty', ''],
    ['not base64', '%%%'],
    ['random text', 'aGVsbG8'],
    ['truncated', encodeCursor(position).slice(0, -3)],
    ['flipped character', flip(encodeCursor(position))],
    ['appended', encodeCursor(position) + 'AAAA'],
  ])(
    'S49 AS-82: tampered cursor (%s) throws InvalidCursorError',
    (_n, value) => {
      expect(() => decodeCursor(value)).toThrow(InvalidCursorError);
    },
  );
});
