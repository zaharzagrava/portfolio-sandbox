import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { ApiConfigService } from '@app/common/config';
import { ConfigRules } from '@app/common/config/config-rules';
import { Environment } from '@app/common/types';
import type { SecretSealerPort } from '../../domain/ports';

const base64Bytes = (value: unknown) =>
  Buffer.from(String(value), 'base64').length;

// FR-066: the master key is mandatory in production and well formed whenever it is set; the previous key (rotation)
// must be a different, well formed key. Messages name keys, never values.
ConfigRules.register({
  owner: 'identity',
  keys: ['auth_kek', 'auth_kek_previous'],
  validate: (ctx) => {
    const found: string[] = [];
    const kek = ctx.get('auth_kek');
    const previous = ctx.get('auth_kek_previous');
    if (ctx.production && !kek) found.push('auth_kek is required');
    if (kek && base64Bytes(kek) !== 32)
      found.push('auth_kek must be 32 bytes (base64)');
    if (previous && base64Bytes(previous) !== 32)
      found.push('auth_kek_previous must be 32 bytes (base64)');
    if (previous && previous === kek)
      found.push('auth_kek_previous must differ from auth_kek');
    return found;
  },
});

/**
 * Envelope-style encryption for secrets we must store (signing private keys,
 * TOTP secrets, OAuth refresh tokens of integrations): AES-256-GCM with a
 * random 96-bit IV per value; format `v1.<iv>.<tag>.<ciphertext>` (base64url).
 * The key-encryption key comes from Secrets Manager in AWS (lesson 05/02 §9);
 * rotating it = re-encrypting with v2 while still decrypting v1.
 */
@Injectable()
export class SecretBox implements SecretSealerPort {
  private readonly key: Buffer;
  /** The master key being rotated out: opens old values, never seals. */
  private readonly previousKey?: Buffer;

  constructor(config: ApiConfigService) {
    const kek = config.get('auth_kek');
    const previous = config.get('auth_kek_previous');
    if (previous) {
      this.previousKey = Buffer.from(previous, 'base64');
      if (this.previousKey.length !== 32)
        throw new Error('AUTH_KEK_PREVIOUS must be 32 bytes (base64)');
    }
    if (kek) {
      this.key = Buffer.from(kek, 'base64');
      if (this.key.length !== 32)
        throw new Error('AUTH_KEK must be 32 bytes (base64)');
    } else {
      if (config.get('node_env') === Environment.production)
        throw new Error('AUTH_KEK is required in production');
      // Deterministic dev/test key so local data survives restarts; never used in production.
      this.key = createHash('sha256')
        .update('marketplace-local-dev-kek')
        .digest();
    }
  }

  /**
   * With a `context` the value is bound to it (`v2`, the context is the GCM additional authenticated data): a
   * ciphertext copied to another row or purpose fails the tag check. Without one the format is the original `v1`.
   */
  seal(plaintext: string, context?: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    if (context) cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return [
      context ? 'v2' : 'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  /** A `v2` value needs its context and a `v1` value must not be opened under one. */
  open(sealed: string, context?: string): string {
    const [version, iv, tag, ciphertext] = sealed.split('.');
    if (version !== 'v1' && version !== 'v2')
      throw new Error(`unsupported secret version ${version}`);
    if ((version === 'v2') !== Boolean(context))
      throw new Error('secret context mismatch');
    try {
      return this.decrypt(this.key, iv, tag, ciphertext, context);
    } catch (error) {
      if (!this.previousKey) throw error;
      return this.decrypt(this.previousKey, iv, tag, ciphertext, context);
    }
  }

  private decrypt(
    key: Buffer,
    iv: string,
    tag: string,
    ciphertext: string,
    context?: string,
  ): string {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(iv, 'base64url'),
    );
    if (context) decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  /**
   * Deterministic keyed digest for values that are compared, not recovered (recovery codes): HMAC-SHA-256 under a
   * key derived from the KEK per `purpose`, so a leaked table cannot be brute-forced offline without the key.
   */
  keyedDigest(purpose: string, value: string): string {
    const key = Buffer.from(
      hkdfSync(
        'sha256',
        this.key,
        Buffer.alloc(0),
        Buffer.from(`digest:${purpose}`, 'utf8'),
        32,
      ),
    );
    return createHmac('sha256', key).update(value, 'utf8').digest('base64url');
  }
}
