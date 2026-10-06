import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ApiScope, generateApiKey, hashSecret, parseApiKey, secretMatches } from '../domain/api-key-format';

export interface VerifiedKey {
  id: string;
  /** The shop the key acts on: the real shop, or its sandbox shadow for test keys. */
  shopId: string;
  ownerShopId: string;
  /** The staff member who created the key: becomes the `sellerId` of products created through it. */
  createdBy: string;
  scopes: ApiScope[];
  livemode: boolean;
}

interface CachedKey extends VerifiedKey {
  hash: string;
  expiresAt: number | null;
  revoked: boolean;
}

const cacheKey = (prefix: string) => `apikey:${prefix}`;
const CACHE_TTL_SEC = 60;
const LAST_USED = 'apikey:lastused';
const ROTATION_OVERLAP_MS = 24 * 3600_000;

/**
 * Keys are looked up by their public prefix and verified by hash on EVERY
 * request (the cache stores the hash, never "this secret is valid"), with a
 * 60 s Redis cache so the hot path has no Postgres read. Revocation deletes
 * the cache entry immediately; `lastUsedAt` is write-behind (a ZSET flushed
 * by a worker) instead of an UPDATE per request.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly redis: RedisService,
    private readonly config: ApiConfigService,
  ) {}

  private get pepper() {
    return this.config.get('api_key_pepper') || this.config.get('jwt_secret');
  }

  async create(shopId: string, userId: string, name: string, scopes: ApiScope[], livemode: boolean, expiresAt?: Date) {
    const { key, prefix, secret } = generateApiKey(livemode);
    const [row] = await this.sequelize.query<{ id: string; createdAt: Date }>(
      `INSERT INTO "ApiKey" ("shopId", prefix, hash, name, scopes, livemode, "createdBy", "expiresAt") VALUES (:shopId, :prefix, :hash, :name, CAST(:scopes AS text[]), :livemode, :userId, :expiresAt)
       RETURNING id, "createdAt"`,
      { type: QueryTypes.SELECT, replacements: { shopId, prefix, hash: hashSecret(secret, this.pepper), name, scopes: `{${scopes.join(',')}}`, livemode, userId, expiresAt: expiresAt ?? null } },
    );
    // The only time the full key exists outside the client.
    return { id: row.id, key, prefix, name, scopes, livemode, createdAt: row.createdAt };
  }

  list(shopId: string) {
    return this.sequelize.query(
      `SELECT id, prefix, name, scopes, livemode, "expiresAt", "revokedAt", "lastUsedAt", "createdAt" FROM "ApiKey" WHERE "shopId" = :shopId ORDER BY "createdAt" DESC`,
      { type: QueryTypes.SELECT, replacements: { shopId } },
    );
  }

  /** New key with the same scopes; the old one keeps working for 24 h so deployments can switch over. */
  async rotate(shopId: string, keyId: string, userId: string) {
    const old = await this.find(shopId, keyId);
    const replacement = await this.create(shopId, userId, `${old.name} (rotated)`, old.scopes, old.livemode);
    await this.sequelize.query(`UPDATE "ApiKey" SET "expiresAt" = LEAST(coalesce("expiresAt", 'infinity'), now() + interval '24 hours') WHERE id = :keyId`, { replacements: { keyId } });
    await this.redis.client.del(cacheKey(old.prefix));
    return { ...replacement, previousExpiresAt: new Date(Date.now() + ROTATION_OVERLAP_MS) };
  }

  async revoke(shopId: string, keyId: string) {
    const key = await this.find(shopId, keyId);
    await this.sequelize.query(`UPDATE "ApiKey" SET "revokedAt" = now() WHERE id = :keyId AND "revokedAt" IS NULL`, { replacements: { keyId } });
    await this.redis.client.del(cacheKey(key.prefix));
  }

  async verify(raw: string): Promise<VerifiedKey | null> {
    const parsed = parseApiKey(raw);
    if (!parsed) return null;
    let cached: CachedKey | null = null;
    const hit = await this.redis.client.get(cacheKey(parsed.prefix));
    if (hit) cached = hit === 'none' ? null : (JSON.parse(hit) as CachedKey);
    else {
      cached = await this.load(parsed.prefix);
      await this.redis.client.set(cacheKey(parsed.prefix), cached ? JSON.stringify(cached) : 'none', 'EX', CACHE_TTL_SEC);
    }
    if (!cached || cached.revoked || cached.livemode !== parsed.livemode) return null;
    if (cached.expiresAt && cached.expiresAt < Date.now()) return null;
    if (!secretMatches(parsed.secret, cached.hash, this.pepper)) return null;

    void this.redis.client.zadd(LAST_USED, Date.now(), cached.id).catch(() => undefined);
    const { hash: _h, expiresAt: _e, revoked: _r, ...key } = cached;
    return key;
  }

  /** Worker: write-behind of lastUsedAt, one statement for all keys used since the last flush. */
  async flushLastUsed(): Promise<number> {
    const entries = await this.redis.client.zrange(LAST_USED, 0, -1, 'WITHSCORES');
    if (entries.length === 0) return 0;
    const ids: string[] = [];
    const ts: string[] = [];
    for (let i = 0; i < entries.length; i += 2) {
      ids.push(entries[i]);
      ts.push(new Date(Number(entries[i + 1])).toISOString());
    }
    await this.sequelize.query(
      `UPDATE "ApiKey" k SET "lastUsedAt" = u.ts FROM unnest(CAST(:ids AS uuid[]), CAST(:ts AS timestamptz[])) AS u(id, ts)
       WHERE k.id = u.id AND (k."lastUsedAt" IS NULL OR k."lastUsedAt" < u.ts)`,
      { replacements: { ids: `{${ids.join(',')}}`, ts: `{${ts.map((t) => `"${t}"`).join(',')}}` } },
    );
    // Remove only what we flushed (scores ≤ our snapshot) - newer uses stay for the next run.
    await this.redis.client.zremrangebyscore(LAST_USED, '-inf', Math.max(...ts.map((t) => Date.parse(t))));
    return ids.length;
  }

  /** Sandbox shadow shop for test keys, created on first use (idempotent via the partial unique index on sandboxOf). */
  async sandboxShopFor(shopId: string): Promise<string> {
    await this.sequelize.query(
      `INSERT INTO "Shop" (id, name, slug, "sandboxOf", "createdAt", "updatedAt")
       SELECT uuidv7(), s.name || ' (sandbox)', s.slug || '-sandbox', s.id, now(), now() FROM "Shop" s WHERE s.id = :shopId
       ON CONFLICT ("sandboxOf") WHERE "sandboxOf" IS NOT NULL DO NOTHING`,
      { replacements: { shopId } },
    );
    const [row] = await this.sequelize.query<{ id: string }>(`SELECT id FROM "Shop" WHERE "sandboxOf" = :shopId`, { type: QueryTypes.SELECT, replacements: { shopId } });
    return row.id;
  }

  private async load(prefix: string): Promise<CachedKey | null> {
    const [row] = await this.sequelize.query<{ id: string; shopId: string; createdBy: string; scopes: ApiScope[]; livemode: boolean; hash: string; expiresAt: Date | null; revokedAt: Date | null }>(
      `SELECT id, "shopId", "createdBy", scopes, livemode, hash, "expiresAt", "revokedAt" FROM "ApiKey" WHERE prefix = :prefix`,
      { type: QueryTypes.SELECT, replacements: { prefix } },
    );
    if (!row) return null;
    const shopId = row.livemode ? row.shopId : await this.sandboxShopFor(row.shopId);
    return { id: row.id, shopId, ownerShopId: row.shopId, createdBy: row.createdBy, scopes: row.scopes, livemode: row.livemode, hash: row.hash, expiresAt: row.expiresAt ? new Date(row.expiresAt).getTime() : null, revoked: !!row.revokedAt };
  }

  private async find(shopId: string, keyId: string) {
    const [row] = await this.sequelize.query<{ prefix: string; name: string; scopes: ApiScope[]; livemode: boolean }>(`SELECT prefix, name, scopes, livemode FROM "ApiKey" WHERE id = :keyId AND "shopId" = :shopId`, {
      type: QueryTypes.SELECT,
      replacements: { keyId, shopId },
    });
    if (!row) throw new NotFoundException('API key not found');
    return row;
  }
}
