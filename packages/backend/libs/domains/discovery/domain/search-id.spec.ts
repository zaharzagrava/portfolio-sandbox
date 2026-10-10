import {
  SEARCH_ID_TTL_MS,
  signSearchId,
  verifySearchId,
} from './search-id';

const KEY = 'k'.repeat(32);
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const payload = { sid: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', q: 'iphone' };

describe('searchId token (S32 AS-70, AS-71, FR-051)', () => {
  it('S32 AS-70: round trips and has the v1.<payload>.<mac> shape', () => {
    const token = signSearchId(KEY, payload, T0);
    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifySearchId(KEY, token, T0 + 1000)).toEqual({
      ok: true,
      payload: { ...payload, iat: T0 },
    });
  });

  it('S32 AS-71: valid up to 24 h, expired 1 s later', () => {
    const token = signSearchId(KEY, payload, T0);
    expect(verifySearchId(KEY, token, T0 + SEARCH_ID_TTL_MS).ok).toBe(true);
    expect(verifySearchId(KEY, token, T0 + SEARCH_ID_TTL_MS + 1000)).toEqual({
      ok: false,
    });
  });

  it('S32 AS-71: a token from the future is refused', () => {
    const token = signSearchId(KEY, payload, T0 + 3_600_000);
    expect(verifySearchId(KEY, token, T0).ok).toBe(false);
  });

  it('S32 AS-71: another key, altered payload or altered mac is refused', () => {
    const token = signSearchId(KEY, payload, T0);
    const [v, body, mac] = token.split('.');
    expect(verifySearchId('z'.repeat(32), token, T0).ok).toBe(false);
    const forgedBody = Buffer.from(
      JSON.stringify({ ...payload, q: 'other', iat: T0 }),
    ).toString('base64url');
    expect(verifySearchId(KEY, `${v}.${forgedBody}.${mac}`, T0).ok).toBe(false);
    const flipped = mac.slice(0, -1) + (mac.endsWith('A') ? 'B' : 'A');
    expect(verifySearchId(KEY, `${v}.${body}.${flipped}`, T0).ok).toBe(false);
    expect(verifySearchId(KEY, `${v}.${body}.${mac.slice(1)}`, T0).ok).toBe(false);
  });

  it.each([
    '',
    'garbage',
    'v1..',
    'v1.a.b',
    'v2.a.b',
    'v1.a.b.c',
    undefined,
    42,
  ])('S32 AS-71: malformed token %p is refused', (token) => {
    expect(verifySearchId(KEY, token as never, T0)).toEqual({ ok: false });
  });

  it('S32 AS-71: a correctly signed payload of the wrong shape is refused', () => {
    // sign through the public API with a bad type to build a validly-MACed bad body
    const bad = signSearchId(KEY, { sid: 1 as never, q: 'x' }, T0);
    expect(verifySearchId(KEY, bad, T0).ok).toBe(false);
  });
});
