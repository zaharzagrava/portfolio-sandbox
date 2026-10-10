import {
  constants,
  createPublicKey,
  verify,
  type JsonWebKey,
} from 'node:crypto';
import { Clock, SystemClock } from '@app/common/core/clock';
import { OidcProviderError } from '../../domain/ports';

export type Fetcher = (
  url: string,
  init: { headers: Record<string, string>; method: string },
) => Promise<Response>;

const KEY_SET_TTL_MS = 3_600_000;
const UNKNOWN_KID_COOLDOWN_MS = 30_000;

interface Entry {
  keys: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }>;
  at: number;
}

const decode = (part: string): Buffer => Buffer.from(part, 'base64url');

/**
 * Checks the signature of an ID token against the provider's published keys. The token comes straight from the token
 * endpoint over TLS, which lets the OAuth library skip this step; the platform requires it anyway (FR-043), with the
 * algorithm pinned to the one discovery advertised (never `none`, never a symmetric one). The key set is cached for an
 * hour per provider and reloaded at most once per 30 s when a token names a key we do not hold (FR-046).
 */
export class IdTokenSignatureVerifier {
  private readonly entries = new Map<string, Entry>();
  private readonly loading = new Map<string, Promise<Entry>>();

  constructor(
    private readonly fetcher: Fetcher,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  async verify(jwksUri: string, idToken: string, alg: string): Promise<void> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new OidcProviderError('token');
    let header: { alg?: unknown; kid?: unknown };
    try {
      header = JSON.parse(decode(parts[0]).toString('utf8'));
    } catch {
      throw new OidcProviderError('token');
    }
    if (header.alg !== alg || typeof header.kid !== 'string')
      throw new OidcProviderError('token');

    const jwk = await this.keyFor(jwksUri, header.kid, alg);
    const ok = this.check(
      alg,
      Buffer.from(`${parts[0]}.${parts[1]}`),
      decode(parts[2]),
      jwk,
    );
    if (!ok) throw new OidcProviderError('token');
  }

  private async keyFor(jwksUri: string, kid: string, alg: string) {
    const find = (entry: Entry) =>
      entry.keys.find(
        (k) =>
          k.kid === kid &&
          (k.alg === undefined || k.alg === alg) &&
          (k.use === undefined || k.use === 'sig'),
      );
    let entry = this.entries.get(jwksUri);
    if (!entry || this.clock.nowMs() - entry.at >= KEY_SET_TTL_MS)
      entry = await this.load(jwksUri);
    let jwk = find(entry);
    if (!jwk && this.clock.nowMs() - entry.at >= UNKNOWN_KID_COOLDOWN_MS) {
      entry = await this.load(jwksUri);
      jwk = find(entry);
    }
    if (!jwk) throw new OidcProviderError('token');
    return jwk;
  }

  private load(jwksUri: string): Promise<Entry> {
    let pending = this.loading.get(jwksUri);
    if (!pending) {
      pending = this.fetchKeys(jwksUri).finally(() =>
        this.loading.delete(jwksUri),
      );
      this.loading.set(jwksUri, pending);
    }
    return pending;
  }

  private async fetchKeys(jwksUri: string): Promise<Entry> {
    const response = await this.fetcher(jwksUri, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (response.status !== 200) throw new OidcProviderError('unavailable');
    let body: { keys?: unknown };
    try {
      body = (await response.json()) as { keys?: unknown };
    } catch {
      throw new OidcProviderError('unavailable');
    }
    if (!Array.isArray(body.keys)) throw new OidcProviderError('unavailable');
    const entry = { keys: body.keys as Entry['keys'], at: this.clock.nowMs() };
    this.entries.set(jwksUri, entry);
    return entry;
  }

  private check(alg: string, data: Buffer, signature: Buffer, jwk: JsonWebKey) {
    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' });
      switch (alg) {
        case 'RS256':
          return verify('sha256', data, key, signature);
        case 'PS256':
          return verify(
            'sha256',
            data,
            {
              key,
              padding: constants.RSA_PKCS1_PSS_PADDING,
              saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
            },
            signature,
          );
        case 'ES256':
          return verify(
            'sha256',
            data,
            { key, dsaEncoding: 'ieee-p1363' },
            signature,
          );
        case 'EdDSA':
          return verify(null, data, key, signature);
        default:
          return false;
      }
    } catch {
      return false;
    }
  }
}
