import { SystemClock } from '@app/common/core/clock';
import { resolveCacheConfig } from './cache.config';
import { CacheLog } from './cache-log';
import { StoreGuard } from './store-guard';

let shared: StoreGuard | undefined;

/**
 * Components that callers construct by hand (Bloom filters, counters, locks) share one timeout + breaker per
 * process unless they are given a guard of their own.
 */
export function sharedStoreGuard(): StoreGuard {
  if (!shared) {
    const clock = new SystemClock();
    shared = new StoreGuard(clock, resolveCacheConfig(), new CacheLog(clock));
  }
  return shared;
}
