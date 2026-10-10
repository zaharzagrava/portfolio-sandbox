/**
 * Public entry of the cache toolkit (S52, constitution X.4): `@app/infrastructure/cache`.
 * Everything a domain may use is exported here; the other files are internal.
 */
export { CacheModule } from './cache.module';
export { CacheService } from './cache.service';
export type { CacheStats } from './cache.service';
export type { GetOrLoadOptions } from './cache-options';
export { cacheKey } from './cache-key';
export { RedisBloomFilter } from './bloom-filter';
export { WriteBehindCounter } from './write-behind-counter';
export type { WriteBehindCounterOptions } from './write-behind-counter';
export { DistributedLock } from './distributed-lock';
export type { Lock } from './distributed-lock';
export { VersionEtagInterceptor, withEtag } from './etag.interceptor';
export { matchesIfNoneMatch } from './etag-match';
export { buildCacheControl } from './cache-control';
export type { CachePolicy } from './cache-control';
export type { CacheToolkitConfig } from './cache.config';
export {
  CacheLoaderBusy,
  CacheUnavailable,
  CounterOverflow,
  InvalidCacheKey,
  InvalidCacheOptions,
  InvalidIncrement,
  InvalidLoaderResult,
  LockTimeout,
  LockUnavailable,
} from './cache.errors';
