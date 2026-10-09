import {
  generateApiKey,
  hashSecret,
  parseApiKey,
  secretMatches,
} from './api-key-format';

/** Key minting/verification is shared by the dashboard, the public API and the worker. */
describe('API key format', () => {
  it('round-trips and encodes the mode in the prefix (secret scanners match sk_live_)', () => {
    const live = generateApiKey(true);
    expect(live.key).toMatch(/^sk_live_[0-9A-Za-z]{12}_[0-9A-Za-z]{32}$/);
    expect(parseApiKey(live.key)).toEqual({
      livemode: true,
      prefix: live.prefix,
      secret: live.secret,
    });
    expect(parseApiKey(generateApiKey(false).key)?.livemode).toBe(false);
    expect(parseApiKey('sk_live_short_bad')).toBeNull();
  });

  it('verifies against the peppered hash only', () => {
    const { secret } = generateApiKey(true);
    const stored = hashSecret(secret, 'pepper');
    expect(secretMatches(secret, stored, 'pepper')).toBe(true);
    expect(secretMatches(secret, stored, 'other-pepper')).toBe(false);
    expect(secretMatches(`${secret.slice(0, -1)}x`, stored, 'pepper')).toBe(
      false,
    );
  });
});
