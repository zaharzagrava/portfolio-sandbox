import { decodeSyncCursor, encodeSyncCursor } from './sync-cursor';

const KEY = 'k'.repeat(40);
const SHOP = '2f1c7a3e-4d5b-4c6d-8e7f-0a1b2c3d4e5f';
const OTHER_SHOP = '3a1c7a3e-4d5b-4c6d-8e7f-0a1b2c3d4e5f';

describe('sync cursor', () => {
  it('S09 AS-31: a cursor goes through encode and decode unchanged', () => {
    const cursor = encodeSyncCursor(
      { shopId: SHOP, generation: 3, seq: 42 },
      KEY,
    );
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeSyncCursor(cursor, SHOP, KEY)).toEqual({
      ok: true,
      generation: 3,
      seq: 42,
    });
  });

  it('S09 AS-31: seq 0 is the start of a generation', () => {
    const cursor = encodeSyncCursor(
      { shopId: SHOP, generation: 1, seq: 0 },
      KEY,
    );
    expect(decodeSyncCursor(cursor, SHOP, KEY)).toEqual({
      ok: true,
      generation: 1,
      seq: 0,
    });
  });

  it('S09 AS-31: a cursor of another shop is invalid', () => {
    const cursor = encodeSyncCursor(
      { shopId: SHOP, generation: 1, seq: 5 },
      KEY,
    );
    expect(decodeSyncCursor(cursor, OTHER_SHOP, KEY)).toEqual({ ok: false });
  });

  it('S09 AS-31: another key does not open it', () => {
    const cursor = encodeSyncCursor(
      { shopId: SHOP, generation: 1, seq: 5 },
      KEY,
    );
    expect(decodeSyncCursor(cursor, SHOP, 'z'.repeat(40))).toEqual({
      ok: false,
    });
  });

  it('S09 AS-31: a changed generation or position breaks the signature', () => {
    const cursor = encodeSyncCursor(
      { shopId: SHOP, generation: 1, seq: 5 },
      KEY,
    );
    const raw = Buffer.from(cursor, 'base64url');
    const text = raw.toString('utf8');
    const tampered = (from: string, to: string) =>
      Buffer.from(text.replace(from, to), 'utf8').toString('base64url');
    expect(decodeSyncCursor(tampered(`.1.5`, `.2.5`), SHOP, KEY).ok).toBe(
      false,
    );
    expect(decodeSyncCursor(tampered(`.1.5`, `.1.9`), SHOP, KEY).ok).toBe(
      false,
    );
  });

  it.each([
    [''],
    ['abc'],
    ['!!!'],
    ['djEuYS5i'],
    [Buffer.from('v1.not-a-shop.1.1').toString('base64url')],
    [Buffer.from(`v2.${SHOP}.1.1`).toString('base64url')],
    [Buffer.from(`v1.${SHOP}.x.1`).toString('base64url')],
    [Buffer.from(`v1.${SHOP}.1.-4`).toString('base64url')],
    ['0'],
  ])('S09 AS-31: %j is malformed', (value) => {
    expect(decodeSyncCursor(value, SHOP, KEY)).toEqual({ ok: false });
  });
});
