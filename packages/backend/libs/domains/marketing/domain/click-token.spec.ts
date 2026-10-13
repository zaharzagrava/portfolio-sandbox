import fc from 'fast-check';
import {
  hashAddress,
  hashViewer,
  keyIdOf,
  signClickToken,
  verifyClickToken,
  type ClickClaims,
} from './click-token';

const SECRET = 'unit-test-ads-click-secret-0123456789abcdef';
const OTHER = 'another-ads-click-secret-0123456789abcdefgh';
const NOW = Date.parse('2026-10-13T10:00:00.000Z');
const ID = (n: number) =>
  `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const claims = (over: Partial<ClickClaims> = {}): ClickClaims => ({
  i: ID(1),
  c: ID(2),
  s: ID(3),
  p: ID(4),
  e: NOW + 30 * 60_000,
  v: 'a'.repeat(32),
  ...over,
});

const keys = { current: SECRET };

describe('S36 AS-24: click token (pure)', () => {
  it('a valid token verifies and returns its claims and key id', () => {
    const token = signClickToken(claims(), keys);
    expect(verifyClickToken(token, keys, NOW)).toEqual({
      ok: true,
      claims: claims(),
      keyId: keyIdOf(SECRET),
    });
  });

  it('now >= exp is expired: one millisecond before is valid, exactly at and after is expired', () => {
    const token = signClickToken(claims({ e: NOW + 1000 }), keys);
    expect(verifyClickToken(token, keys, NOW + 999).ok).toBe(true);
    expect(verifyClickToken(token, keys, NOW + 1000)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyClickToken(token, keys, NOW + 5000)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('a truncated or lengthened signature fails without throwing', () => {
    const token = signClickToken(claims(), keys);
    for (const bad of [
      token.slice(0, -1),
      token.slice(0, -10),
      `${token}A`,
      `${token}AAAAAAAA`,
    ])
      expect(verifyClickToken(bad, keys, NOW)).toEqual({
        ok: false,
        reason: 'invalid',
      });
  });

  it.each([
    ['empty string', ''],
    ['no segments', 'abc'],
    ['three segments', 'v1.abcdef01.e30'],
    ['five segments', 'v1.abcdef01.e30.AAAA.BBBB'],
    ['not base64', 'v1.abcdef01.@@@@.@@@@'],
    ['unknown version', 'v9.abcdef01.e30.AAAA'],
    ['dots only', '...'],
  ])('malformed: %s', (_name, token) => {
    expect(verifyClickToken(token, keys, NOW)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('a payload that is not JSON fails even with a correct signature', () => {
    const token = signClickToken(claims(), keys);
    const [, kid] = token.split('.');
    const forged = signRaw(kid, Buffer.from('not json').toString('base64url'));
    expect(verifyClickToken(forged, keys, NOW)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it.each([
    ['impression id missing', { ...claims(), i: undefined }],
    ['impression id not a uuid', claims({ i: 'not-a-uuid' })],
    ['campaign id not a uuid', claims({ c: '123' })],
    ['expiry not an integer', claims({ e: 1.5 })],
    ['expiry is a string', { ...claims(), e: '999' }],
    ['viewer hash too short', claims({ v: 'abc' })],
    ['an extra claim', { ...claims(), x: 1 }],
  ])(
    'wrong claim shape fails even with a correct signature: %s',
    (_name, bad) => {
      const token = signClickToken(bad as ClickClaims, keys);
      expect(verifyClickToken(token, keys, NOW)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    },
  );

  it('a token signed with a different secret fails', () => {
    const token = signClickToken(claims(), { current: OTHER });
    expect(verifyClickToken(token, keys, NOW)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('a previous key is accepted while configured and refused once removed (AS-25 pure half)', () => {
    const old = signClickToken(claims(), { current: OTHER });
    expect(
      verifyClickToken(old, { current: SECRET, previous: OTHER }, NOW).ok,
    ).toBe(true);
    expect(verifyClickToken(old, { current: SECRET }, NOW).ok).toBe(false);
    expect(keyIdOf(SECRET)).not.toBe(keyIdOf(OTHER));
    expect(keyIdOf(SECRET)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('property: verify(sign(c)) = c before expiry', () => {
    fc.assert(
      fc.property(
        fc.record({
          i: fc.uuid({ version: 7 }),
          c: fc.uuid(),
          s: fc.uuid(),
          p: fc.uuid(),
          e: fc.integer({ min: NOW + 1, max: NOW + 10 ** 9 }),
          v: fc.stringMatching(/^[0-9a-f]{32}$/),
        }),
        (c) => {
          const r = verifyClickToken(signClickToken(c, keys), keys, NOW);
          expect(r.ok && r.claims).toEqual(c);
        },
      ),
      { seed: 36, numRuns: 100 },
    );
  });

  it('property: any single-character mutation fails and verification never throws', () => {
    const token = signClickToken(claims(), keys);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: token.length - 1 }),
        fc.constantFrom(...'ABCxyz019-_.'),
        (index, ch) => {
          fc.pre(token[index] !== ch);
          const mutated = token.slice(0, index) + ch + token.slice(index + 1);
          expect(verifyClickToken(mutated, keys, NOW).ok).toBe(false);
        },
      ),
      { seed: 36, numRuns: 300 },
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 4000 }), (junk) => {
        expect(() => verifyClickToken(junk, keys, NOW)).not.toThrow();
      }),
      { seed: 36, numRuns: 200 },
    );
  });

  it('viewer and address hashes are 32 hex, keyed, deterministic and domain separated', () => {
    const v = hashViewer(SECRET, 'user:42');
    expect(v).toMatch(/^[0-9a-f]{32}$/);
    expect(hashViewer(SECRET, 'user:42')).toBe(v);
    expect(hashViewer(OTHER, 'user:42')).not.toBe(v);
    expect(hashViewer(SECRET, 'user:43')).not.toBe(v);
    expect(hashAddress(SECRET, '203.0.113.9')).toMatch(/^[0-9a-f]{32}$/);
    expect(hashAddress(SECRET, 'user:42')).not.toBe(
      hashViewer(SECRET, 'user:42'),
    );
  });
});

/** Signs an arbitrary payload exactly like the production signer would: lets a spec forge a correctly signed bad payload. */
function signRaw(kid: string, payload: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHmac } = require('node:crypto') as typeof import('node:crypto');
  const subkey = createHmac('sha256', SECRET).update('ads:token').digest();
  const signature = createHmac('sha256', subkey)
    .update(`v1.${kid}.${payload}`)
    .digest('base64url');
  return `v1.${kid}.${payload}.${signature}`;
}
