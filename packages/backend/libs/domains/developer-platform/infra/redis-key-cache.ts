import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { CachedKey, KeyCache } from '../domain/ports';

export const KEY_CACHE_PREFIX = 'apikey:';
export const KEY_TOMBSTONE_PREFIX = 'apikey:revoked:';
export const LAST_USED_KEY = 'apikey:lastused';
/** Longer than any entry can live (60 s) plus the time a slow filler may hold a pre-commit read. */
const TOMBSTONE_TTL_SEC = 180;

const DRAIN = `
local all = redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')
if #all > 0 then redis.call('DEL', KEYS[1]) end
return all
`;

/**
 * Key metadata in the fast store (research R-03). One `MGET` serves the hot path (entry + tombstone, 0 database
 * statements on a hit); `SET NX` makes a fill never overwrite a newer state; a revoke leaves a tombstone that outlives
 * every entry, so a verification that read the row before the commit cannot bring the key back to life.
 */
@Injectable()
export class RedisKeyCache extends KeyCache {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async get(
    prefix: string,
  ): Promise<{ entry: CachedKey | 'none' | null; tombstone: boolean }> {
    const [entry, tomb] = await this.redis.client.mget(
      `${KEY_CACHE_PREFIX}${prefix}`,
      `${KEY_TOMBSTONE_PREFIX}${prefix}`,
    );
    return {
      entry:
        entry === null || entry === 'none'
          ? (entry as 'none' | null)
          : (JSON.parse(entry) as CachedKey),
      tombstone: tomb !== null,
    };
  }

  async fillIfAbsent(
    prefix: string,
    entry: CachedKey | 'none',
    ttlSec: number,
  ): Promise<void> {
    await this.redis.client.set(
      `${KEY_CACHE_PREFIX}${prefix}`,
      entry === 'none' ? 'none' : JSON.stringify(entry),
      'EX',
      ttlSec,
      'NX',
    );
  }

  async tombstone(prefix: string): Promise<void> {
    await this.redis.client.set(
      `${KEY_TOMBSTONE_PREFIX}${prefix}`,
      '1',
      'EX',
      TOMBSTONE_TTL_SEC,
    );
    await this.redis.client.del(`${KEY_CACHE_PREFIX}${prefix}`);
  }

  async invalidate(prefix: string): Promise<void> {
    await this.redis.client.del(`${KEY_CACHE_PREFIX}${prefix}`);
  }

  async touch(id: string, at: Date): Promise<void> {
    await this.redis.client.zadd(LAST_USED_KEY, 'GT', at.getTime(), id);
  }

  async drainUses(): Promise<{ id: string; at: Date }[]> {
    const raw = (await this.redis.client.eval(
      DRAIN,
      1,
      LAST_USED_KEY,
    )) as string[];
    const uses: { id: string; at: Date }[] = [];
    for (let i = 0; i < raw.length; i += 2)
      uses.push({ id: raw[i], at: new Date(Number(raw[i + 1])) });
    return uses;
  }

  async restoreUses(uses: { id: string; at: Date }[]): Promise<void> {
    if (uses.length === 0) return;
    const pipeline = this.redis.client.pipeline();
    for (const u of uses)
      pipeline.zadd(LAST_USED_KEY, 'GT', u.at.getTime(), u.id);
    await pipeline.exec();
  }
}
