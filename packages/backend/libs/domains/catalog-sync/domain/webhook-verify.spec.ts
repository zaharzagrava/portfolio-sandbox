import * as crypto from 'node:crypto';

jest.mock('node:crypto', () => {
  const actual =
    jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return { ...actual, timingSafeEqual: jest.fn(actual.timingSafeEqual) };
});

import {
  WEBHOOK_TOLERANCE_MS,
  checkTimestamp,
  verifyHmacSha256Base64,
} from './webhook-verify';

const secret = 'whsec_test';
const body = Buffer.from('{"id":1,"title":"x"}');
const sign = (b: Buffer | string, s = secret) =>
  crypto.createHmac('sha256', s).update(b).digest('base64');

describe('S08 webhook verification', () => {
  it('S08 AS-27: accepts the base64 HMAC-SHA256 over the raw bytes', () => {
    expect(verifyHmacSha256Base64(secret, body, sign(body))).toBe(true);
  });

  it.each([
    ['wrong secret', sign(body, 'other')],
    [
      're-serialised body (whitespace changed)',
      sign('{"id": 1, "title": "x"}'),
    ],
    ['absent', undefined],
    ['empty', ''],
    ['too short (length mismatch)', sign(body).slice(0, 10)],
    ['too long (length mismatch)', `${sign(body)}AAAA`],
    [
      'hex instead of base64',
      crypto.createHmac('sha256', secret).update(body).digest('hex'),
    ],
    [
      'same length, last characters changed',
      `${sign(body).slice(0, -2)}${sign(body).endsWith('A=') ? 'B=' : 'A='}`,
    ],
  ])('S08 AS-27: rejects %s without throwing', (_n, sig) => {
    expect(verifyHmacSha256Base64(secret, body, sig)).toBe(false);
  });

  it('S08 AS-27: bytes, not text - a non-UTF-8 body verifies against its own bytes only', () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x7b]);
    expect(verifyHmacSha256Base64(secret, bytes, sign(bytes))).toBe(true);
    expect(
      verifyHmacSha256Base64(
        secret,
        Buffer.from(bytes.toString('utf8')),
        sign(bytes),
      ),
    ).toBe(false);
  });

  it('S08 AS-27: an empty secret never verifies', () => {
    expect(verifyHmacSha256Base64('', body, sign(body, ''))).toBe(false);
  });

  it('S08 AS-27: the comparison is constant-time (crypto.timingSafeEqual is used)', () => {
    const spy = crypto.timingSafeEqual as jest.Mock;
    spy.mockClear();
    verifyHmacSha256Base64(secret, body, sign(body));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('S08 webhook timestamp rule', () => {
  const now = new Date('2026-10-15T12:00:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it('S08 AS-29: tolerance is 300 s', () => {
    expect(WEBHOOK_TOLERANCE_MS).toBe(300_000);
  });

  it.each([
    ['299 s', 299_000, 'ok'],
    ['300 s exactly', 300_000, 'ok'],
    ['300 s 1 ms', 300_001, 'stale'],
    ['301 s', 301_000, 'stale'],
    ['0 s', 0, 'ok'],
  ])('S08 AS-29: triggered %s ago -> %s', (_n, age, expected) => {
    expect(checkTimestamp(ago(age), now)).toBe(expected);
  });

  it('S08 AS-29: accepts Date objects as well as ISO strings', () => {
    expect(checkTimestamp(new Date(now.getTime() - 301_000), now)).toBe(
      'stale',
    );
  });

  it('S08 AS-29: a provider without timestamp (WooCommerce) is not rejected here', () => {
    expect(checkTimestamp(undefined, now)).toBe('ok');
  });

  it('S08 AS-29: an unparseable timestamp is invalid, a far-future one is stale', () => {
    expect(checkTimestamp('yesterday-ish', now)).toBe('invalid');
    expect(checkTimestamp('', now)).toBe('invalid');
    expect(checkTimestamp(ago(-301_000), now)).toBe('stale');
    expect(checkTimestamp(ago(-60_000), now)).toBe('ok');
  });
});
