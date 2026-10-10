import {
  createSign,
  createHmac,
  generateKeyPairSync,
  KeyObject,
} from 'node:crypto';
import {
  peekKid,
  verifyAccessToken,
  verifyPurposeToken,
} from './token-verifier';
import { Domain_InvalidTokenError } from './errors';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const nowSec = Math.floor(NOW.getTime() / 1000);
const SUB = '0190b0a8-6f1c-7a52-8d8c-3b1a2c4d5e6f';
const SID = '0190b0a8-6f1c-7a52-8d8c-3b1a2c4d5e70';
const KID = 'key-1';

const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64 = (v: unknown) =>
  Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString(
    'base64url',
  );

const validHeader = { alg: 'ES256', typ: 'at+jwt', kid: KID };
const validClaims = {
  iss: 'marketplace',
  aud: 'marketplace-api',
  sub: SUB,
  sid: SID,
  role: 'USER',
  amr: ['pwd'],
  iat: nowSec - 10,
  nbf: nowSec - 10,
  exp: nowSec + 290,
  jti: 'jti-1',
};

function sign(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key: KeyObject = ec.privateKey,
  alg: 'ES256' | 'RS256' = 'ES256',
): string {
  const input = `${b64(header)}.${b64(claims)}`;
  const signer = createSign('sha256').update(input);
  const sig =
    alg === 'ES256'
      ? signer.sign({ key, dsaEncoding: 'ieee-p1363' })
      : signer.sign(key);
  return `${input}.${sig.toString('base64url')}`;
}

const good = () => sign(validHeader, validClaims);

describe('S01 AS-23: token verifier', () => {
  it('accepts a valid ES256 at+jwt and returns the principal from claims only', () => {
    expect(verifyAccessToken(good(), ec.publicKey, NOW)).toEqual({
      id: SUB,
      role: 'USER',
      sessionId: SID,
      amr: ['pwd'],
    });
  });

  it('peekKid returns the kid of a well-formed header', () => {
    expect(peekKid(good())).toBe(KID);
  });

  const cases: Array<[string, () => string, KeyObject?]> = [
    [
      'forged signature (other key)',
      () => sign(validHeader, validClaims, other.privateKey),
    ],
    [
      'tampered payload',
      () => {
        const [h, , s] = good().split('.');
        return `${h}.${b64({ ...validClaims, role: 'ADMIN' })}.${s}`;
      },
    ],
    [
      'alg none',
      () => `${b64({ ...validHeader, alg: 'none' })}.${b64(validClaims)}.`,
    ],
    [
      'alg HS256 signed with the public key bytes',
      () => {
        const input = `${b64({ ...validHeader, alg: 'HS256' })}.${b64(validClaims)}`;
        const mac = createHmac(
          'sha256',
          ec.publicKey.export({ format: 'pem', type: 'spki' }),
        )
          .update(input)
          .digest('base64url');
        return `${input}.${mac}`;
      },
    ],
    [
      'alg RS256',
      () =>
        sign(
          { ...validHeader, alg: 'RS256' },
          validClaims,
          rsa.privateKey,
          'RS256',
        ),
    ],
    ['wrong iss', () => sign(validHeader, { ...validClaims, iss: 'evil' })],
    ['wrong aud', () => sign(validHeader, { ...validClaims, aud: 'mfa' })],
    [
      'aud as array',
      () => sign(validHeader, { ...validClaims, aud: ['marketplace-api'] }),
    ],
    [
      'typ mfa+jwt (purpose token)',
      () => sign({ ...validHeader, typ: 'mfa+jwt' }, validClaims),
    ],
    [
      'typ svc+jwt (purpose token)',
      () => sign({ ...validHeader, typ: 'svc+jwt' }, validClaims),
    ],
    ['no typ', () => sign({ alg: 'ES256', kid: KID }, validClaims)],
    [
      'expired beyond tolerance',
      () => sign(validHeader, { ...validClaims, exp: nowSec - 6 }),
    ],
    [
      'nbf in the future beyond tolerance',
      () => sign(validHeader, { ...validClaims, nbf: nowSec + 6 }),
    ],
    [
      'malformed kid',
      () => sign({ ...validHeader, kid: '../../etc/passwd' }, validClaims),
    ],
    ['missing kid', () => sign({ alg: 'ES256', typ: 'at+jwt' }, validClaims)],
    [
      'missing sub',
      () => sign(validHeader, { ...validClaims, sub: undefined }),
    ],
    [
      'missing sid',
      () => sign(validHeader, { ...validClaims, sid: undefined }),
    ],
    [
      'missing exp',
      () => sign(validHeader, { ...validClaims, exp: undefined }),
    ],
    ['unknown role', () => sign(validHeader, { ...validClaims, role: 'ROOT' })],
    ['not three segments', () => 'a.b'],
    ['empty', () => ''],
    ['garbage', () => 'not-a-token'],
    ['oversized', () => `${'a'.repeat(9000)}.b.c`],
  ];

  it.each(cases)('rejects: %s', (_name, make) => {
    expect(() => verifyAccessToken(make(), ec.publicKey, NOW)).toThrow(
      Domain_InvalidTokenError,
    );
  });

  it('tolerates 5 seconds of clock skew on exp and nbf', () => {
    const tok = sign(validHeader, {
      ...validClaims,
      exp: nowSec - 4,
      nbf: nowSec + 4,
    });
    expect(verifyAccessToken(tok, ec.publicKey, NOW).id).toBe(SUB);
  });

  it('verifyPurposeToken accepts only the expected typ and aud', () => {
    const mfa = sign(
      { alg: 'ES256', typ: 'mfa+jwt', kid: KID },
      { ...validClaims, aud: 'mfa', sid: undefined },
    );
    expect(
      verifyPurposeToken(mfa, ec.publicKey, NOW, {
        typ: 'mfa+jwt',
        aud: 'mfa',
      }).sub,
    ).toBe(SUB);
    expect(() =>
      verifyPurposeToken(mfa, ec.publicKey, NOW, {
        typ: 'svc+jwt',
        aud: 'mfa',
      }),
    ).toThrow(Domain_InvalidTokenError);
    expect(() => verifyAccessToken(mfa, ec.publicKey, NOW)).toThrow(
      Domain_InvalidTokenError,
    );
  });
});
