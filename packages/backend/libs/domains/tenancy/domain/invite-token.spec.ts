import {
  digestInviteToken,
  generateInviteToken,
  INVITE_TTL_MS,
} from './invite-token';

describe('S03 invite token', () => {
  it('is 192 bits of url-safe randomness and unique', () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(Buffer.from(a, 'base64url')).toHaveLength(24);
  });

  it('digests with sha256 hex and is deterministic', () => {
    expect(digestInviteToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('lives seven days', () => {
    expect(INVITE_TTL_MS).toBe(7 * 24 * 3600 * 1000);
  });
});
