import { createHash } from 'node:crypto';
import type { ApiConfigService } from '@app/common/config';
import { SecretBox } from './secret-box';

const config = (kek?: Buffer, previous?: Buffer, env = 'test') =>
  ({
    get: (key: string) =>
      key === 'auth_kek'
        ? kek?.toString('base64')
        : key === 'auth_kek_previous'
          ? previous?.toString('base64')
          : key === 'node_env'
            ? env
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

  describe('S01 AS-67', () => {
    const OLD = Buffer.alloc(32, 1);
    const NEW = Buffer.alloc(32, 2);
    const swap = (sealed: string, index: number, value?: string) => {
      const parts = sealed.split('.');
      parts[index] = value ?? `${parts[index].slice(0, -2)}AA`;
      return parts.join('.');
    };

    it.each([
      ['iv', 1],
      ['tag', 2],
      ['ciphertext', 3],
    ])('rejects a tampered %s', (_part, index) => {
      const sealed = box.seal('secret', 'ctx');
      expect(() => box.open(swap(sealed, index), 'ctx')).toThrow();
    });

    it('rejects a tampered or unknown version', () => {
      const sealed = box.seal('secret', 'ctx');
      expect(() => box.open(swap(sealed, 0, 'v3'), 'ctx')).toThrow(
        /unsupported/,
      );
      expect(() => box.open(swap(sealed, 0, 'v1'), 'ctx')).toThrow();
    });

    it('opens a value sealed with the previous master key while current and previous are configured', () => {
      const sealedByOld = new SecretBox(config(OLD)).seal('rotating', 'ctx');
      const rotated = new SecretBox(config(NEW, OLD));
      expect(rotated.open(sealedByOld, 'ctx')).toBe('rotating');
      // New values are sealed with the current key only.
      const fresh = rotated.seal('fresh', 'ctx');
      expect(() => new SecretBox(config(OLD)).open(fresh, 'ctx')).toThrow();
      expect(new SecretBox(config(NEW)).open(fresh, 'ctx')).toBe('fresh');
    });

    it('does not open a value sealed with the previous key once it is no longer configured', () => {
      const sealedByOld = new SecretBox(config(OLD)).seal('rotating');
      expect(() => new SecretBox(config(NEW)).open(sealedByOld)).toThrow();
    });

    it('still opens a context-free legacy value', () => {
      expect(box.open(box.seal('legacy'))).toBe('legacy');
    });

    it('refuses to start in production without a master key and with a malformed one', () => {
      expect(
        () => new SecretBox(config(undefined, undefined, 'production')),
      ).toThrow(/AUTH_KEK is required/);
      expect(
        () => new SecretBox(config(Buffer.alloc(16), undefined, 'production')),
      ).toThrow();
      expect(() => new SecretBox(config(NEW, Buffer.alloc(5)))).toThrow(
        /AUTH_KEK_PREVIOUS/,
      );
      expect(
        () => new SecretBox(config(NEW, undefined, 'production')),
      ).not.toThrow();
    });
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
