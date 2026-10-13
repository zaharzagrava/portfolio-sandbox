import { signCursor, verifyCursor } from './cursor';

const SECRET = 'x'.repeat(40);
const USER = '0b7c1a52-1111-4a2b-9c3d-000000000001';
const OTHER = '0b7c1a52-1111-4a2b-9c3d-000000000002';
const POSITION = {
  eventTime: new Date('2026-03-05T10:20:30.123Z'),
  id: '1b7c1a52-1111-1a2b-9c3d-0a0b0c0d0e0f',
};

describe('inbox cursor', () => {
  it('S28 AS-56: a cursor round-trips for the user it was issued to and stays opaque and short', () => {
    const cursor = signCursor(USER, POSITION, SECRET);
    expect(cursor.length).toBeLessThanOrEqual(512);
    expect(cursor).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(cursor).not.toContain(USER);
    expect(verifyCursor(cursor, USER, SECRET)).toEqual(POSITION);
  });

  it('S28 AS-56: a cursor issued to another user, signed with another key, altered or malformed is refused', () => {
    const cursor = signCursor(USER, POSITION, SECRET);
    expect(verifyCursor(cursor, OTHER, SECRET)).toBeNull();
    expect(verifyCursor(cursor, USER, 'y'.repeat(40))).toBeNull();
    const [payload, mac] = cursor.split('.');
    const last = payload.endsWith('A') ? 'B' : 'A';
    const flipped = [payload.slice(0, -1) + last, mac].join('.');
    expect(verifyCursor(flipped, USER, SECRET)).toBeNull();
    for (const bad of ['', 'garbage', '.', 'a.b.c', payload + '.', '.' + mac])
      expect(verifyCursor(bad, USER, SECRET)).toBeNull();
  });
});
