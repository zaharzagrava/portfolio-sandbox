import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  randomUUID,
} from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  SECRET_SEALER,
  SIGNING_KEY_REPOSITORY,
  type SecretSealerPort,
  type SigningKeyRepository,
  type SigningKeyRow,
} from '../../domain/ports';
import { KeyCachePolicy } from '../../domain/key-cache-policy';
import { TOKEN_ISSUER } from '../../domain/token-verifier';

interface LoadedKey {
  kid: string;
  alg: 'ES256';
  status: SigningKeyRow['status'];
  publicJwk: Record<string, unknown>;
  publicKey: KeyObject;
  privateKey?: KeyObject;
}

export interface SignOptions {
  expiresInSec: number;
  audience?: string;
  /** JOSE `typ` header (`at+jwt`, `mfa+jwt`, `svc+jwt`); omitted = a plain JWT. */
  typ?: string;
  jwtId?: string;
}

/**
 * Rotating JWT signing keys (lesson 05/02 §2, 10/09 #39):
 *   NEXT    - published in JWKS, not used to sign yet (verifiers' caches pick it up)
 *   ACTIVE  - signs new tokens
 *   RETIRED - still published until every token it signed has expired
 * Verification picks the key by `kid` and pins the algorithm to that key's
 * alg - never trusts the token's `alg` header ("alg: none"/HS256 confusion).
 * The key set is cached per process (`KeyCachePolicy`: 300 s, one forced reload per 30 s for an unknown `kid`).
 */
@Injectable()
export class KeyStore {
  private readonly logger = new Logger(KeyStore.name);
  private cache?: LoadedKey[];
  private readonly policy = new KeyCachePolicy();

  constructor(
    @Inject(SIGNING_KEY_REPOSITORY)
    private readonly repository: SigningKeyRepository,
    @Inject(SECRET_SEALER) private readonly box: SecretSealerPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async sign(payload: object, options: SignOptions): Promise<string> {
    let active = (await this.keys()).find((k) => k.status === 'ACTIVE');
    if (!active) {
      // Fresh environment before the worker's rotation job ever ran. Concurrent bootstraps race on the partial unique
      // index; the loser (insert returns false) just reloads.
      await this.createKey('ACTIVE');
      active = (await this.keys(true)).find((k) => k.status === 'ACTIVE');
    }
    if (!active?.privateKey) throw new Error('no ACTIVE signing key');
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    return jwt.sign(
      {
        ...payload,
        iss: TOKEN_ISSUER,
        ...(options.audience && { aud: options.audience }),
        iat,
        nbf: iat,
        exp: iat + options.expiresInSec,
        ...(options.jwtId && { jti: options.jwtId }),
      },
      active.privateKey,
      {
        algorithm: active.alg,
        keyid: active.kid,
        ...(options.typ && { header: { typ: options.typ } as never }),
      },
    );
  }

  /** Returns the verification key for a kid, or undefined (unknown/rotated-out key → reject). */
  async verificationKey(
    kid: string,
  ): Promise<{ key: KeyObject; alg: 'ES256' } | undefined> {
    let key = (await this.keys()).find((k) => k.kid === kid);
    if (!key && this.policy.mayForceReload(kid, this.clock.now()))
      key = (await this.keys(true)).find((k) => k.kid === kid);
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

  /**
   * Generates a new key (ES256: small tokens, fast signing). `null` when a unique index says another instance
   * created the ACTIVE/NEXT key first.
   */
  async createKey(status: 'NEXT' | 'ACTIVE' = 'NEXT'): Promise<string | null> {
    const { publicKey, privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    const kid = randomUUID();
    const now = this.clock.now();
    const inserted = await this.repository.insert({
      kid,
      publicJwk: publicKey.export({ format: 'jwk' }),
      privateKeySealed: this.box.seal(
        privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      ),
      status,
      activatedAt: status === 'ACTIVE' ? now : null,
      createdAt: now,
    });
    this.cache = undefined;
    this.policy.reset();
    if (!inserted) {
      this.logger.log(`${status} signing key already created elsewhere`);
      return null;
    }
    this.logger.log(`created ${status} signing key ${kid}`);
    return kid;
  }

  invalidate(): void {
    this.cache = undefined;
    this.policy.reset();
  }

  private async keys(force = false): Promise<LoadedKey[]> {
    const now = this.clock.now();
    if (!force && this.cache && !this.policy.needsRefresh(now))
      return this.cache;
    const rows = await this.repository.list();
    this.cache = rows.map((row) => ({
      kid: row.kid,
      alg: 'ES256' as const,
      status: row.status,
      publicJwk: row.publicJwk,
      publicKey: createPublicKey({
        key: row.publicJwk as never,
        format: 'jwk',
      }),
      privateKey:
        row.status === 'ACTIVE'
          ? createPrivateKey(this.box.open(row.privateKeySealed))
          : undefined,
    }));
    this.policy.loaded(now);
    return this.cache;
  }
}
