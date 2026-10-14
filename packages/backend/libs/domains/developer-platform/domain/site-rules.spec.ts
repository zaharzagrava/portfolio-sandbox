import {
  generatePublishableKey,
  generateIdentitySecret,
  isPublishableKey,
  previousSecretState,
  overlapExpiry,
} from './site-rules';

const WIDGET_PUBLISHABLE_KEY = /^pk_live_[A-Za-z0-9_-]{24}$/;
const WIDGET_IDENTITY_SECRET = /^wis_[A-Za-z0-9_-]{43}$/;

const NOW = new Date('2026-10-06T12:00:00.000Z');

describe('S44 FR-002 site key format', () => {
  it.each([
    ['pk_live_abcdefghijklmnopqrstuvwx', true],
    ['pk_live_ABCDEFGHIJKLMNOPQRSTUV-_', true],
    ['pk_live_x', false],
    ['', false],
    ['pk_test_abcdefghijklmnopqrstuvwx', false],
    ['pk_live_abcdefghijklmnopqrstuvwx!', false],
    ['pk_live_abcdefghijklmnopqrstuvw', false],
    ['pk_live_abcdefghijklmnopqrstuvwxy', false],
    ['x'.repeat(500), false],
  ])('S44 AS-17: %j -> %s', (key, expected) => {
    expect(isPublishableKey(key)).toBe(expected);
  });

  it('S44 AS-01: generated key and secret match their formats and differ every time', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const key = generatePublishableKey();
      const secret = generateIdentitySecret();
      expect(key).toMatch(WIDGET_PUBLISHABLE_KEY);
      expect(secret).toMatch(WIDGET_IDENTITY_SECRET);
      keys.add(key + secret);
    }
    expect(keys.size).toBe(50);
  });
});

describe('S44 AS-28 previous secret overlap', () => {
  it('S44 AS-10: expiry is now plus the overlap hours', () => {
    expect(overlapExpiry(NOW, 24).toISOString()).toBe(
      '2026-10-07T12:00:00.000Z',
    );
    expect(overlapExpiry(NOW, 0).toISOString()).toBe(NOW.toISOString());
    expect(overlapExpiry(NOW, 72).toISOString()).toBe(
      '2026-10-09T12:00:00.000Z',
    );
  });

  it.each([
    [null, 'none'],
    [new Date('2026-10-06T12:00:01.000Z'), 'valid'],
    [new Date('2026-10-06T12:00:00.000Z'), 'expired'],
    [new Date('2026-10-06T11:59:59.000Z'), 'expired'],
  ] as const)(
    'S44 AS-28: expiry %s at the injected now -> %s',
    (expiresAt, state) => {
      expect(previousSecretState(expiresAt, NOW)).toBe(state);
    },
  );
});
