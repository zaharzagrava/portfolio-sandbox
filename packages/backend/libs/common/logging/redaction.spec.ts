import { REDACTED, redact } from './redaction';

describe('log redaction (U-RED)', () => {
  it('S54 AS-148: secret-bearing keys read [REDACTED] at any depth, case-insensitively; other values are untouched', () => {
    const input = {
      ctx: {
        user: { password: 'p', profile: { refreshToken: 'r', note: 'ok' } },
      },
      headers: {
        Authorization: 'Bearer x',
        'x-api-key': 'k',
        cookie: 'c',
        'Set-Cookie': ['a=b'],
      },
      token: 't',
      secret: 's',
    };
    expect(redact(input)).toEqual({
      ctx: {
        user: {
          password: REDACTED,
          profile: { refreshToken: REDACTED, note: 'ok' },
        },
      },
      headers: {
        Authorization: REDACTED,
        'x-api-key': REDACTED,
        cookie: REDACTED,
        'Set-Cookie': REDACTED,
      },
      token: REDACTED,
      secret: REDACTED,
    });
  });

  it.each([
    'password',
    'PASSWORD',
    'passwordHash',
    'token',
    'accessToken',
    'refreshToken',
    'authorization',
    'Authorization',
    'cookie',
    'set-cookie',
    'secret',
    'clientSecret',
    'apiKey',
    'api_key',
    'x-api-key',
    'cardNumber',
    'iban',
  ])('S54 AS-148: the key %s is redacted', (key) => {
    expect(redact({ [key]: 'value-that-must-not-leak' })).toEqual({
      [key]: REDACTED,
    });
  });

  it.each([
    'note',
    'userId',
    'shopId',
    'requestId',
    'amount',
    'tokenCount',
    'authority',
  ])('S54 AS-148: the key %s is left alone', (key) => {
    expect(redact({ [key]: 'visible' })).toEqual({ [key]: 'visible' });
  });

  it('S54 AS-148: arrays are walked and the input is not mutated', () => {
    const input = { items: [{ token: 'a', name: 'x' }, { name: 'y' }] };
    const snapshot = JSON.stringify(input);
    expect(redact(input)).toEqual({
      items: [{ token: REDACTED, name: 'x' }, { name: 'y' }],
    });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('S54 AS-148: circular input does not throw and does not loop', () => {
    const input: Record<string, unknown> = { name: 'loop', password: 'p' };
    input.self = input;
    const out = redact(input) as Record<string, unknown>;
    expect(out.password).toBe(REDACTED);
    expect(out.self).toBe('[Circular]');
  });

  it('S54 AS-148: a value with a newline serialises as one JSON line', () => {
    const line = JSON.stringify(
      redact({ message: 'first\nsecond', nested: { text: 'a\r\nb' } }),
    );
    expect(line).not.toMatch(/[\r\n]/);
    expect(JSON.parse(line)).toEqual({
      message: 'first\nsecond',
      nested: { text: 'a\r\nb' },
    });
  });

  it('S54 AS-148: primitives, null and class instances pass through', () => {
    class Opaque {
      password = 'kept-because-opaque';
    }
    const instance = new Opaque();
    expect(redact('text')).toBe('text');
    expect(redact(null)).toBeNull();
    expect(redact(42)).toBe(42);
    expect(redact({ instance })).toEqual({ instance });
  });
});
