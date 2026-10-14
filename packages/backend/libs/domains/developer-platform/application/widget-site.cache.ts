import { Injectable } from '@nestjs/common';
import { CacheService, cacheKey } from '@app/infrastructure/cache';
import {
  WidgetSiteRepository,
  type WidgetSiteView,
} from '../domain/widget-ports';

/** Longest a well-formed key that matched no site is remembered (FR-012, AS-17); a creation clears it at once. */
export const UNKNOWN_KEY_MEMORY_MS = 30_000;
/** Fresh window and stale-on-error window of the shaped configuration (FR-016, AS-21). */
export const CONFIG_FRESH_MS = 60_000;
export const CONFIG_STALE_MS = 600_000;
const SITE_TTL_MS = 300_000;

/**
 * The site record of the public hot path (FR-017). It lives in the shared store only (`l1: 'never'`, S52 follow-up):
 * no instance keeps a copy that a change on another instance could leave behind, and every write drops the entry (and
 * the shaped configuration built from it) through the toolkit's cross-instance invalidation. The record holds no secret.
 * The caller shape-checks the key first; a malformed key never reaches this class, so it never becomes a cache key.
 */
@Injectable()
export class WidgetSiteCache {
  constructor(
    private readonly cache: CacheService,
    private readonly sites: WidgetSiteRepository,
  ) {}

  static siteKey = (publishableKey: string): string =>
    cacheKey('widget-site', 1, publishableKey);
  static configKey = (publishableKey: string): string =>
    cacheKey('widget-config', 1, publishableKey);

  get(publishableKey: string): Promise<WidgetSiteView | null> {
    return this.cache.getOrLoad<WidgetSiteView>(
      WidgetSiteCache.siteKey(publishableKey),
      () => this.sites.findViewByKey(publishableKey),
      {
        ttlMs: SITE_TTL_MS,
        negativeTtlMs: UNKNOWN_KEY_MEMORY_MS,
        jitter: 0,
        l1: 'never',
      },
    );
  }

  /** After every change of a site: the record and the configuration shaped from it are rebuilt on the next request. */
  async invalidate(publishableKeys: readonly string[]): Promise<void> {
    const keys = publishableKeys.flatMap((k) => [
      WidgetSiteCache.siteKey(k),
      WidgetSiteCache.configKey(k),
    ]);
    if (keys.length) await this.cache.invalidate(keys);
  }
}
