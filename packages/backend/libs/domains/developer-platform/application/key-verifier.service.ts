import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  hashSecretWithVersion,
  parseApiKey,
  verifySecret,
  type ApiScope,
} from '../domain/api-key-format';
import { serviceUnavailable } from '../domain/errors';
import {
  ApiKeyRepository,
  CachedKey,
  KeyCache,
  ShopDirectory,
} from '../domain/ports';
import { apiMetrics } from './metrics';
import { KeyPeppers } from './key-peppers';

export const KEY_ENTRY_TTL_SEC = 60;
const UNKNOWN_TTL_SEC = 10;
/** A hash to compare against when the prefix is unknown, so unknown and wrong-secret keys cost the same. */
const DUMMY_SECRET = 'x'.repeat(32);

export interface VerifiedKey {
  id: string;
  /** The shop every lookup is scoped to: the live shop, or the sandbox shop of a test key. */
  shopId: string;
  /** The live shop that owns the key. */
  liveShopId: string;
  createdBy: string;
  scopes: ApiScope[];
  livemode: boolean;
}

export type RefusalReason =
  'malformed' | 'unknown' | 'mismatch' | 'revoked' | 'expired';

export type VerifyOutcome =
  { ok: true; key: VerifiedKey } | { ok: false; reason: RefusalReason };

/**
 * The hot path of every public call (FR-008, FR-019, R-03): one `MGET` for the entry and the revoke tombstone, a fill
 * that never overwrites, the hash compared on every request, expiry decided with the injected clock. When the fast
 * store fails the system of record serves the call; when that fails too the answer is `503`, never `401`.
 * Returns `null` for every reason a credential is refused (the caller answers one identical `401`).
 */
@Injectable()
export class KeyVerifier {
  private readonly logger = new Logger(KeyVerifier.name);

  constructor(
    private readonly keys: ApiKeyRepository,
    private readonly cache: KeyCache,
    private readonly directory: ShopDirectory,
    private readonly peppers: KeyPeppers,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async verify(raw: string): Promise<VerifiedKey | null> {
    const outcome = await this.check(raw);
    return outcome.ok ? outcome.key : null;
  }

  /** Like `verify`, with the reason a credential was refused (counted by the caller, never put in a response). */
  async check(raw: string): Promise<VerifyOutcome> {
    const parsed = parseApiKey(raw);
    if (!parsed) return { ok: false, reason: 'malformed' };

    const now = this.clock.now();
    const entry = await this.entryFor(parsed.prefix);
    if (entry === 'revoked') return { ok: false, reason: 'revoked' };
    if (!entry) {
      verifySecret(DUMMY_SECRET, 'unknown', 1, this.peppers.current);
      return { ok: false, reason: 'unknown' };
    }
    const check = verifySecret(
      parsed.secret,
      entry.hash,
      entry.hashVersion,
      this.peppers.current,
    );
    if (!check.ok || entry.livemode !== parsed.livemode)
      return { ok: false, reason: 'mismatch' };
    if (entry.revoked) return { ok: false, reason: 'revoked' };
    if (entry.expiresAt !== null && entry.expiresAt <= now.getTime())
      return { ok: false, reason: 'expired' };

    if (check.rehash) await this.rehash(entry, parsed.prefix, parsed.secret);
    await this.cache.touch(entry.id, now).catch(() => undefined);
    return {
      ok: true,
      key: {
        id: entry.id,
        shopId: entry.actingShopId,
        liveShopId: entry.shopId,
        createdBy: entry.createdBy,
        scopes: entry.scopes,
        livemode: entry.livemode,
      },
    };
  }

  /** The cached entry or the stored one; `'revoked'` for a tombstone; `null` for an unknown prefix. */
  private async entryFor(
    prefix: string,
  ): Promise<CachedKey | 'revoked' | null> {
    let cacheUp = true;
    try {
      const hit = await this.cache.get(prefix);
      if (hit.tombstone) return 'revoked';
      if (hit.entry === 'none') return null;
      if (hit.entry) return hit.entry;
    } catch (error) {
      cacheUp = false;
      apiMetrics.keyCacheDegraded().add(1);
      this.logger.warn(`key cache unavailable: ${(error as Error).message}`);
    }

    let record;
    try {
      record = await this.keys.findByPrefix(prefix);
    } catch (error) {
      this.logger.error(`key store unavailable: ${(error as Error).message}`);
      apiMetrics.authUnavailable().add(1);
      throw serviceUnavailable();
    }
    if (!record) {
      if (cacheUp)
        await this.cache
          .fillIfAbsent(prefix, 'none', UNKNOWN_TTL_SEC)
          .catch(() => undefined);
      return null;
    }
    const entry: CachedKey = {
      id: record.id,
      shopId: record.shopId,
      actingShopId: record.livemode
        ? record.shopId
        : await this.sandboxShop(record.shopId),
      createdBy: record.createdBy,
      hash: record.hash,
      hashVersion: record.hashVersion,
      scopes: record.scopes,
      livemode: record.livemode,
      expiresAt: record.expiresAt ? record.expiresAt.getTime() : null,
      revoked: record.revokedAt !== null,
    };
    if (cacheUp)
      await this.cache
        .fillIfAbsent(prefix, entry, KEY_ENTRY_TTL_SEC)
        .catch(() => undefined);
    return entry;
  }

  private async sandboxShop(liveShopId: string): Promise<string> {
    try {
      return await this.directory.sandboxShopOf(liveShopId);
    } catch (error) {
      this.logger.error(
        `sandbox shop unavailable: ${(error as Error).message}`,
      );
      throw serviceUnavailable();
    }
  }

  /** A key hashed with the previous pepper is stored again under the current one (best effort). */
  private async rehash(
    entry: CachedKey,
    prefix: string,
    secret: string,
  ): Promise<void> {
    try {
      await this.keys.rehash(
        entry.id,
        hashSecretWithVersion(secret, this.peppers.current, 1),
      );
      await this.cache.invalidate(prefix).catch(() => undefined);
    } catch (error) {
      this.logger.warn(`re-hash failed: ${(error as Error).message}`);
    }
  }
}
