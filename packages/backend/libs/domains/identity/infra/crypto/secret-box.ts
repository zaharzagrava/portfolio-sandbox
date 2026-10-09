import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { ApiConfigService } from '@app/common/config';
import { Environment } from '@app/common/types';

/**
 * Envelope-style encryption for secrets we must store (signing private keys,
 * TOTP secrets, OAuth refresh tokens of integrations): AES-256-GCM with a
 * random 96-bit IV per value; format `v1.<iv>.<tag>.<ciphertext>` (base64url).
 * The key-encryption key comes from Secrets Manager in AWS (lesson 05/02 §9);
 * rotating it = re-encrypting with v2 while still decrypting v1.
 */
@Injectable()
export class SecretBox {
  private readonly key: Buffer;

  constructor(config: ApiConfigService) {
    const kek = config.get('auth_kek');
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

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  open(sealed: string): string {
    const [version, iv, tag, ciphertext] = sealed.split('.');
    if (version !== 'v1')
      throw new Error(`unsupported secret version ${version}`);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
