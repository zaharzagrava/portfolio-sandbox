import {
  base32Encode,
  generateSecret,
  otpauthUri,
  totpCode,
  verifyTotp,
} from './totp';

const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
const STEP_MS = 30_000;
const stepOf = (nowMs: number) => Math.floor(nowMs / STEP_MS);

describe('S02 AS-10: TOTP verifier', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('RFC 6238 SHA-1 vector at T=%d is %s', (seconds, code) => {
    expect(totpCode(RFC_SECRET, stepOf(seconds * 1000))).toBe(code);
    expect(
      verifyTotp({ secret: RFC_SECRET, code, nowMs: seconds * 1000 }),
    ).toEqual({ valid: true, step: stepOf(seconds * 1000) });
  });

  const nowMs = 1_700_000_000_000;
  const now = stepOf(nowMs);

  it.each([-1, 0, 1])('accepts a code %d step(s) away', (offset) => {
    const code = totpCode(RFC_SECRET, now + offset);
    expect(verifyTotp({ secret: RFC_SECRET, code, nowMs })).toEqual({
      valid: true,
      step: now + offset,
    });
  });

  it.each([-2, 2, 10])('refuses a code %d steps away', (offset) => {
    const code = totpCode(RFC_SECRET, now + offset);
    expect(verifyTotp({ secret: RFC_SECRET, code, nowMs }).valid).toBe(false);
  });

  it('refuses a step at or below the last accepted one (replay), accepts a later one', () => {
    const code = totpCode(RFC_SECRET, now);
    expect(
      verifyTotp({ secret: RFC_SECRET, code, nowMs, lastStep: now }).valid,
    ).toBe(false);
    expect(
      verifyTotp({ secret: RFC_SECRET, code, nowMs, lastStep: now + 1 }).valid,
    ).toBe(false);
    expect(
      verifyTotp({ secret: RFC_SECRET, code, nowMs, lastStep: now - 1 }),
    ).toEqual({ valid: true, step: now });
  });

  it.each([
    ['empty', ''],
    ['five digits', '12345'],
    ['seven digits', '1234567'],
    ['letters', 'abcdef'],
    ['leading space', ' 123456'],
    ['trailing newline', '123456\n'],
    ['inner space', '123 456'],
    ['arabic-indic digits', '١٢٣٤٥٦'],
    ['fullwidth digits', '１２３４５６'],
  ])('refuses malformed input: %s', (_name, code) => {
    expect(verifyTotp({ secret: RFC_SECRET, code, nowMs }).valid).toBe(false);
  });

  it('generates 160-bit secrets that differ per call', () => {
    const a = generateSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateSecret()).not.toBe(a);
  });

  it('builds an otpauth URI an authenticator app can read', () => {
    const uri = otpauthUri({
      issuer: 'Marketplace',
      label: 'a@example.com',
      secret: RFC_SECRET,
    });
    const url = new URL(uri);
    expect(url.protocol).toBe('otpauth:');
    expect(url.host).toBe('totp');
    expect(decodeURIComponent(url.pathname)).toBe('/Marketplace:a@example.com');
    expect(url.searchParams.get('secret')).toBe(RFC_SECRET);
    expect(url.searchParams.get('issuer')).toBe('Marketplace');
    expect(url.searchParams.get('algorithm')).toBe('SHA1');
    expect(url.searchParams.get('digits')).toBe('6');
    expect(url.searchParams.get('period')).toBe('30');
  });
});
