import { createHash } from 'node:crypto';
import type { ApiConfigService } from '@app/common/config';
import { SecretBox } from './secret-box';

const config = (kek?: Buffer) =>
  ({
    get: (key: string) =>
      key === 'auth_kek'
        ? kek?.toString('base64')
        : key === 'node_env'
          ? 'test'
          : undefined,
  }) as unknown as ApiConfigService;

describe('S02 SecretBox', () => {
  const box = new SecretBox(config());

  it('keeps the context-free v1 format and round-trips', () => {
    const sealed = box.seal('hello');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(box.open(sealed)).toBe('hello');
  });

  it('seals with a context as v2 and opens only with the same context', () => {
    const sealed = box.seal('hello', 'mfa:user-a');
    expect(sealed.startsWith('v2.')).toBe(true);
    expect(box.open(sealed, 'mfa:user-a')).toBe('hello');
    expect(() => box.open(sealed, 'mfa:user-b')).toThrow();
    expect(() => box.open(sealed)).toThrow();
  });

  it('refuses a ciphertext copied to another context', () => {
    const sealed = box.seal('secret-of-a', 'mfa:A');
    expect(() => box.open(sealed, 'mfa:B')).toThrow();
  });

  it('refuses a context-free v1 value when a context is demanded', () => {
    expect(() => box.open(box.seal('x'), 'mfa:A')).toThrow();
  });

  it('produces a different ciphertext on every seal', () => {
    expect(box.seal('a', 'c')).not.toBe(box.seal('a', 'c'));
  });

  describe('keyedDigest', () => {
    it('is deterministic, base64url, and differs per purpose and per value', () => {
      const a = box.keyedDigest('mfa-recovery', 'ABCDEFGHJK');
      expect(a).toBe(box.keyedDigest('mfa-recovery', 'ABCDEFGHJK'));
      expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(a).not.toBe(box.keyedDigest('other', 'ABCDEFGHJK'));
      expect(a).not.toBe(box.keyedDigest('mfa-recovery', 'ABCDEFGHJM'));
    });

    it('differs from plain SHA-256 and from a different key', () => {
      const value = 'ABCDEFGHJK';
      expect(box.keyedDigest('mfa-recovery', value)).not.toBe(
        createHash('sha256').update(value).digest('base64url'),
      );
      const other = new SecretBox(config(Buffer.alloc(32, 7)));
      expect(other.keyedDigest('mfa-recovery', value)).not.toBe(
        box.keyedDigest('mfa-recovery', value),
      );
    });
  });
});
