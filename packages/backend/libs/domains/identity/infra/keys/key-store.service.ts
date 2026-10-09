import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  randomUUID,
} from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import SigningKey from '../models/signing-key.model';
import { SecretBox } from '../crypto/secret-box';

const CACHE_MS = 60_000;

interface LoadedKey {
  kid: string;
  alg: 'ES256' | 'RS256';
  status: SigningKey['status'];
  publicJwk: Record<string, unknown>;
  publicKey: KeyObject;
  privateKey?: KeyObject;
}

/**
 * Rotating JWT signing keys (lesson 05/02 §2, 10/09 #39):
 *   NEXT    - published in JWKS, not used to sign yet (verifiers' caches pick it up)
 *   ACTIVE  - signs new tokens
 *   RETIRED - still published until every token it signed has expired
 * Verification picks the key by `kid` and pins the algorithm to that key's
 * alg - never trusts the token's `alg` header ("alg: none"/HS256 confusion).
 */
@Injectable()
export class KeyStore {
  private readonly logger = new Logger(KeyStore.name);
  private cache?: { at: number; keys: LoadedKey[] };

  constructor(
    @InjectModel(SigningKey) private readonly keyModel: typeof SigningKey,
    private readonly box: SecretBox,
  ) {}

  async sign(
    payload: object,
    { expiresInSec, audience }: { expiresInSec: number; audience?: string },
  ): Promise<string> {
    let active = (await this.keys()).find((k) => k.status === 'ACTIVE');
    if (!active) {
      // Fresh environment before the worker's rotation job ever ran. Concurrent
      // bootstraps race on the partial unique index; the loser just reloads.
      await this.createKey('ACTIVE').catch(() => undefined);
      active = (await this.keys(true)).find((k) => k.status === 'ACTIVE');
    }
    if (!active?.privateKey) throw new Error('no ACTIVE signing key');
    return jwt.sign(payload, active.privateKey, {
      algorithm: active.alg,
      keyid: active.kid,
      expiresIn: expiresInSec,
      issuer: 'marketplace',
      ...(audience && { audience }),
    });
  }

  /** Returns the verification key for a kid, or undefined (unknown/rotated-out key → reject). */
  async verificationKey(
    kid: string,
  ): Promise<{ key: KeyObject; alg: 'ES256' | 'RS256' } | undefined> {
    let key = (await this.keys()).find((k) => k.kid === kid);
    if (!key) key = (await this.keys(true)).find((k) => k.kid === kid); // freshly rotated - refresh once
    return key ? { key: key.publicKey, alg: key.alg } : undefined;
  }

  async jwks(): Promise<{ keys: Record<string, unknown>[] }> {
    return {
      keys: (await this.keys()).map((k) => ({
        ...k.publicJwk,
        kid: k.kid,
        alg: k.alg,
        use: 'sig',
      })),
    };
  }

  /** Generates a new NEXT key (ES256: small tokens, fast signing). */
  async createKey(status: 'NEXT' | 'ACTIVE' = 'NEXT'): Promise<string> {
    const { publicKey, privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    const kid = randomUUID();
    await this.keyModel.create({
      kid,
      alg: 'ES256',
      publicJwk: publicKey.export({ format: 'jwk' }) as Record<string, unknown>,
      privateKeyEnc: this.box.seal(
        privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      ),
      status,
      activatedAt: status === 'ACTIVE' ? new Date() : null,
    });
    this.cache = undefined;
    this.logger.log(`created ${status} signing key ${kid}`);
    return kid;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  private async keys(force = false): Promise<LoadedKey[]> {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_MS)
      return this.cache.keys;
    const rows = await this.keyModel.findAll({ raw: true });
    const keys = rows.map((row) => ({
      kid: row.kid,
      alg: row.alg,
      status: row.status,
      publicJwk: row.publicJwk,
      publicKey: createPublicKey({
        key: row.publicJwk as never,
        format: 'jwk',
      }),
      privateKey:
        row.status === 'ACTIVE'
          ? createPrivateKey(this.box.open(row.privateKeyEnc))
          : undefined,
    }));
    this.cache = { at: Date.now(), keys };
    return keys;
  }
}
