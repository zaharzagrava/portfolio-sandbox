import { MAX_ID_TOKEN_BYTES, readIdTokenClaims } from './id-token-claims';

const base = { sub: 'abc-123', email: 'Ann@Example.com', email_verified: true };

describe('S02 AS-36: ID-token claim reader', () => {
  it('reads subject and a normalised, verified e-mail; ignores unknown claims', () => {
    expect(
      readIdTokenClaims({ ...base, name: 'x', hd: 'y', picture: 'z' }),
    ).toEqual({
      ok: true,
      identity: {
        subject: 'abc-123',
        email: 'ann@example.com',
        emailVerified: true,
      },
    });
  });

  it.each([
    ['string "true"', 'true'],
    ['number 1', 1],
    ['string "false"', 'false'],
    ['false', false],
    ['missing', undefined],
    ['null', null],
  ])('treats email_verified %s as unverified', (_n, value) => {
    expect(readIdTokenClaims({ ...base, email_verified: value })).toMatchObject(
      { ok: true, identity: { emailVerified: false } },
    );
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a string', 42],
    ['too long', 'x'.repeat(256)],
    ['whitespace only', '   '],
  ])('refuses a subject that is %s', (_n, sub) => {
    expect(readIdTokenClaims({ ...base, sub })).toEqual({
      ok: false,
      reason: 'subject',
    });
  });

  it('accepts a subject of exactly 255 characters', () => {
    expect(readIdTokenClaims({ ...base, sub: 'x'.repeat(255) }).ok).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['not an address', 'not-an-email'],
    ['two at signs', 'a@b@c.com'],
    ['not a string', 7],
    ['too long', `${'a'.repeat(250)}@example.com`],
    ['with spaces', 'a b@example.com'],
  ])('reads a %s e-mail as no e-mail, never verified', (_n, email) => {
    expect(readIdTokenClaims({ ...base, email })).toEqual({
      ok: true,
      identity: { subject: 'abc-123', email: null, emailVerified: false },
    });
  });

  it('exposes the 8 KB cap on the raw ID token', () => {
    expect(MAX_ID_TOKEN_BYTES).toBe(8 * 1024);
  });

  it('refuses a non-object', () => {
    expect(readIdTokenClaims(null)).toEqual({ ok: false, reason: 'claims' });
    expect(readIdTokenClaims('x')).toEqual({ ok: false, reason: 'claims' });
  });
});
