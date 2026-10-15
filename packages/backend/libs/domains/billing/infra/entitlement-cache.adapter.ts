import { Injectable, Logger } from '@nestjs/common';
import {
  CacheService,
  cacheKey,
  type GetOrLoadOptions,
} from '@app/infrastructure/cache';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import {
  entitlementInvalidationFailed,
  entitlementsUnavailable,
} from '../domain/errors';
import {
  entitlementsCacheErrorsCounter,
  entitlementsStaleServedCounter,
} from '../domain/metrics';
import type { CachedEntitlements, EntitlementCachePort } from '../domain/ports';
import type { SubjectType } from '../domain/types';

/** Fresh for 300 s (FR-009); a failed load serves an entry up to 60 minutes old: 5 minutes fresh plus 55 stale (FR-013). */
const TTL_MS = 300_000;
const STALE_IF_ERROR_MS = 55 * 60_000;
/** After a versioned invalidation, loads older than the event are refused for this long (long enough for a slow load). */
const FENCE_MS = 30_000;

/** The version the cache orders entries by; a free-tier entry (no subscription) is version 0 (research R-1). */
const versionOf = (entry: CachedEntitlements): number =>
  entry.subscriptionVersion ?? 0;

const OPTIONS: GetOrLoadOptions<CachedEntitlements> = {
  ttlMs: TTL_MS,
  staleIfErrorMs: STALE_IF_ERROR_MS,
  // deterministic expiry: the spec fixes the lifetime, and the number of subjects per process is bounded
  jitter: 0,
  l1: 'hot',
  versionOf,
};

const degradedReads = (): number =>
  MetricsRegistry.value('cache_requests_total', {
    namespace: 'entitlements',
    outcome: 'degraded',
  }) ?? 0;

const keyOf = (subjectType: SubjectType, subjectId: string): string =>
  cacheKey('entitlements', 1, subjectType, subjectId);

/**
 * The entitlement cache of S18 over the S52 `CacheService` (research R-1): cache-aside with a 300 s lifetime, one load
 * per key and process, an entry served up to 60 minutes after the source failed, and version-guarded invalidation. A
 * failed load is never turned into an answer (`entitlements_unavailable`); a failed invalidation is never swallowed
 * (`entitlement_invalidation_failed`); a failing cache store only slows reads down (the source answers).
 */
@Injectable()
export class EntitlementCacheAdapter implements EntitlementCachePort {
  private readonly logger = new Logger(EntitlementCacheAdapter.name);

  constructor(private readonly cache: CacheService) {}

  async load(
    subjectType: SubjectType,
    subjectId: string,
    loader: () => Promise<CachedEntitlements>,
  ): Promise<CachedEntitlements> {
    const failures: unknown[] = [];
    const degradedBefore = degradedReads();
    let entry: CachedEntitlements | null;
    try {
      entry = await this.cache.getOrLoad(
        keyOf(subjectType, subjectId),
        async () => {
          try {
            return await loader();
          } catch (error) {
            failures.push(error);
            throw error;
          }
        },
        OPTIONS,
      );
    } catch (error) {
      this.logger.warn(
        `entitlements could not be loaded: ${(error as Error).message}`,
      );
      throw entitlementsUnavailable();
    }
    this.observe(failures, degradedBefore);
    if (!entry) throw entitlementsUnavailable();
    return entry;
  }

  async loadMany(
    subjectType: SubjectType,
    subjectIds: string[],
    batchLoader: (
      missing: string[],
    ) => Promise<Map<string, CachedEntitlements>>,
  ): Promise<Map<string, CachedEntitlements>> {
    const ids = [...new Set(subjectIds)];
    if (ids.length === 0) return new Map();
    const keys = ids.map((id) => keyOf(subjectType, id));
    const idOfKey = new Map(keys.map((key, i) => [key, ids[i]]));
    const failures: unknown[] = [];
    const degradedBefore = degradedReads();
    let entries: (CachedEntitlements | null)[];
    try {
      entries = await this.cache.getOrLoadMany(
        keys,
        async (missing) => {
          try {
            const loaded = await batchLoader(
              missing.map((key) => idOfKey.get(key) as string),
            );
            return new Map(
              missing.map((key) => [
                key,
                loaded.get(idOfKey.get(key) as string) ?? null,
              ]),
            );
          } catch (error) {
            failures.push(error);
            throw error;
          }
        },
        OPTIONS,
      );
    } catch (error) {
      this.logger.warn(
        `entitlements could not be loaded: ${(error as Error).message}`,
      );
      throw entitlementsUnavailable();
    }
    this.observe(failures, degradedBefore);
    const result = new Map<string, CachedEntitlements>();
    entries.forEach((entry, i) => {
      if (!entry) throw entitlementsUnavailable();
      result.set(ids[i], entry);
    });
    return result;
  }

  async invalidate(subjectType: SubjectType, subjectId: string): Promise<void> {
    const { l2 } = await this.cache.invalidate([keyOf(subjectType, subjectId)]);
    if (l2 === 'failed') {
      entitlementsCacheErrorsCounter.add(1);
      throw entitlementInvalidationFailed();
    }
  }

  async invalidateIfOlder(
    subjectType: SubjectType,
    subjectId: string,
    subscriptionId: string,
    subscriptionVersion: number,
  ): Promise<'applied' | 'stale_event'> {
    const key = keyOf(subjectType, subjectId);
    try {
      const cached = await this.cache.peek<CachedEntitlements>(key);
      if (cached && cached.value.subscriptionId === subscriptionId) {
        // the same subscription: versions order its events (a different one is a re-subscription, below)
        if (versionOf(cached.value) >= subscriptionVersion)
          return 'stale_event';
      } else if (cached) {
        const { l2 } = await this.cache.invalidate([key]);
        if (l2 === 'failed') throw new Error('invalidation failed');
        return 'applied';
      }
      // older entry of the same subscription, or none: drop it and raise the floor, so a load that began before this
      // event and returns an older state never stores (FR-012)
      await this.cache.invalidateIfOlder(key, subscriptionVersion, {
        minimumRetentionMs: FENCE_MS,
      });
      return 'applied';
    } catch (error) {
      entitlementsCacheErrorsCounter.add(1);
      this.logger.warn(
        `entitlement invalidation failed: ${(error as Error).message}`,
      );
      throw entitlementInvalidationFailed();
    }
  }

  /** Counts a stale answer (the source failed but an entry was served) and a degraded read (the store failed). */
  private observe(failures: unknown[], degradedBefore: number): void {
    if (failures.length > 0) entitlementsStaleServedCounter.add(1);
    if (degradedReads() > degradedBefore) entitlementsCacheErrorsCounter.add(1);
  }
}
