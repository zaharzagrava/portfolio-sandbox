import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM for session records (S48 FR-041, research R-4). Encoding `kid "." nonce "." ciphertext "." tag`, all
 * base64url. The key ring holds at most two keys: the first encrypts, every key may decrypt (rotation). The additional
 * authenticated data is the store key, so a record copied under another key fails to decrypt.
 */
export class SessionCipher {
  private readonly ring: { kid: string; key: Buffer }[];

  constructor(keys: readonly Buffer[]) {
    if (keys.length < 1 || keys.length > 2 || keys.some((k) => k.length !== 32))
      throw new Error('SessionCipher needs one or two 32-byte keys');
    this.ring = keys.map((key) => ({
      kid: createHash('sha256')
        .update(key)
        .digest()
        .subarray(0, 4)
        .toString('base64url'),
      key,
    }));
  }

  encrypt(plaintext: string, aad: string): string {
    const { kid, key } = this.ring[0];
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return [
      kid,
      nonce.toString('base64url'),
      body.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }

  /** `undefined` for anything that is not a record this ring produced for this `aad` (tampered, foreign key, copied). */
  decrypt(encoded: string, aad: string): string | undefined {
    const parts = encoded.split('.');
    if (parts.length !== 4) return undefined;
    const [kid, nonce, body, tag] = parts;
    const candidates = this.ring.filter((r) => r.kid === kid);
    for (const { key } of candidates) {
      try {
        const nonceBytes = Buffer.from(nonce, 'base64url');
        const tagBytes = Buffer.from(tag, 'base64url');
        if (nonceBytes.length !== NONCE_BYTES || tagBytes.length !== TAG_BYTES)
          continue;
        const decipher = createDecipheriv('aes-256-gcm', key, nonceBytes);
        decipher.setAAD(Buffer.from(aad));
        decipher.setAuthTag(tagBytes);
        return Buffer.concat([
          decipher.update(Buffer.from(body, 'base64url')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        continue;
      }
    }
    return undefined;
  }
}
