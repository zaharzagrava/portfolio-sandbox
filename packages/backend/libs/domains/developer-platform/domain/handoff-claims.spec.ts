import { evaluateHandoffClaims, type HandoffRejection } from './handoff-claims';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const KEY = 'pk_live_abcdefghijklmnopqrstuvwx';

const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: KEY,
  aud: 'marketplace-widget',
  sub: 'cust-42',
  jti: 'jti-12345678',
  exp: NOW_S + 120,
  ...over,
});

const without = (name: string): Record<string, unknown> => {
  const claims = base();
  delete claims[name];
  return claims;
};

const ACCEPT: [string, Record<string, unknown>][] = [
  ['valid', base()],
  ['with email', base({ email: 'buyer@example.com' })],
  ['exp exactly 300 s ahead', base({ exp: NOW_S + 300 })],
  ['nbf 30 s in the future', base({ nbf: NOW_S + 30 })],
  ['iat 60 s in the future', base({ iat: NOW_S + 60 })],
  ['sub of 128 characters', base({ sub: 's'.repeat(128) })],
  ['jti of 8 characters', base({ jti: '12345678' })],
  ['jti of 128 characters', base({ jti: 'j'.repeat(128) })],
  [
    'email of 254 characters',
    base({ email: `${'a'.repeat(242)}@example.com` }),
  ],
  ['extra unknown claims', base({ role: 'admin', foo: { bar: 1 } })],
];

const REJECT: [string, Record<string, unknown>, HandoffRejection][] = [
  ['sub missing', without('sub'), 'bad_subject'],
  ['sub empty', base({ sub: '' }), 'bad_subject'],
  ['sub of 129 characters', base({ sub: 's'.repeat(129) }), 'bad_subject'],
  ['sub not a string', base({ sub: 42 }), 'bad_subject'],
  ['jti missing', without('jti'), 'bad_jti'],
  ['jti of 7 characters', base({ jti: '1234567' }), 'bad_jti'],
  ['jti of 129 characters', base({ jti: 'j'.repeat(129) }), 'bad_jti'],
  ['jti not a string', base({ jti: 12345678 }), 'bad_jti'],
  ['exp missing', without('exp'), 'missing_exp'],
  ['exp not an integer', base({ exp: NOW_S + 10.5 }), 'missing_exp'],
  ['exp a string', base({ exp: String(NOW_S + 10) }), 'missing_exp'],
  ['exp equal to now', base({ exp: NOW_S }), 'expired'],
  ['exp in the past', base({ exp: NOW_S - 1 }), 'expired'],
  ['exp 301 s ahead', base({ exp: NOW_S + 301 }), 'too_long_lived'],
  ['exp an hour ahead', base({ exp: NOW_S + 3600 }), 'too_long_lived'],
  ['aud different', base({ aud: 'marketplace-api' }), 'bad_audience'],
  ['aud an array', base({ aud: ['marketplace-widget'] }), 'bad_audience'],
  ['aud missing', without('aud'), 'bad_audience'],
  [
    'iss different',
    base({ iss: 'pk_live_zzzzzzzzzzzzzzzzzzzzzzzz' }),
    'bad_issuer',
  ],
  ['iss missing', without('iss'), 'bad_issuer'],
  ['nbf 31 s in the future', base({ nbf: NOW_S + 31 }), 'not_yet_valid'],
  ['iat 61 s in the future', base({ iat: NOW_S + 61 }), 'bad_issued_at'],
  ['email not an address', base({ email: 'not-an-address' }), 'bad_email'],
  ['email with a space', base({ email: 'a b@example.com' }), 'bad_email'],
  [
    'email over 254 characters',
    base({ email: `${'a'.repeat(243)}@example.com` }),
    'bad_email',
  ],
  ['email not a string', base({ email: 42 }), 'bad_email'],
  ['email null', base({ email: null }), 'bad_email'],
];

describe('S44 AS-24 hand-off claims policy', () => {
  it.each(ACCEPT)('S44 AS-24: accepts %s', (_name, claims) => {
    const result = evaluateHandoffClaims(claims, {
      now: NOW,
      publishableKey: KEY,
    });
    expect(result.ok).toBe(true);
  });

  it('S44 AS-24: an accepted token yields the subject, jti, expiry and email', () => {
    expect(
      evaluateHandoffClaims(base({ email: 'buyer@example.com' }), {
        now: NOW,
        publishableKey: KEY,
      }),
    ).toEqual({
      ok: true,
      claims: {
        sub: 'cust-42',
        jti: 'jti-12345678',
        exp: NOW_S + 120,
        email: 'buyer@example.com',
      },
    });
    expect(
      evaluateHandoffClaims(base(), { now: NOW, publishableKey: KEY }),
    ).toMatchObject({ ok: true, claims: { email: null } });
  });

  it.each(REJECT)('S44 AS-24: rejects %s as %s', (_name, claims, reason) => {
    expect(
      evaluateHandoffClaims(claims, { now: NOW, publishableKey: KEY }),
    ).toEqual({ ok: false, reason });
  });
});
