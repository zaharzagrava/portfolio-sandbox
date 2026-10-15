import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  ENTITLEMENT_CACHE,
  USAGE_STORE,
  type CachedEntitlements,
  type EntitlementCachePort,
  type UsageStorePort,
} from '../domain/ports';
import {
  Domain_EntitlementRequiredError,
  Domain_UsageUnavailableError,
  tooManyIds,
} from '../domain/errors';
import {
  ENTITLEMENT_KEYS,
  assertEntitlementKey,
  checkLimit as limitOf,
  freeTier,
  hasEntitlement as hasKey,
  quotaLimit,
  quotaMetric,
  type EntitlementKey,
  type Entitlements,
  type LimitKey,
  type QuotaKey,
} from '../domain/entitlements';
import { entitlementChecksCounter } from '../domain/metrics';
import type { SubjectType } from '../domain/types';
import { SubscriptionBasisService } from './subscription-basis.service';

export type {
  EntitlementKey,
  Entitlements,
  LimitKey,
  QuotaKey,
} from '../domain/entitlements';
export { Domain_EntitlementRequiredError, Domain_UsageUnavailableError };

export interface QuotaStatus {
  allowed: boolean;
  used: number;
  limit: number;
  resetsAt: string;
}

export interface LimitStatus {
  allowed: boolean;
  limit: number;
  remaining: number;
}

const MAX_IDS = 500;

/** The committed subscription the entry was built from; both `null` for the free tier. */
export interface SubscriptionRef {
  subscriptionId: string;
  subscriptionVersion: number;
}

/**
 * What a subject may do (S18 FR-001 to FR-007): features and limits derived from the live subscription, never a plan
 * name. The subscription comes only from S17's basis service (committed state); the answer is cached behind a port.
 * PAST_DUE keeps access (grace period); UNPAID and CANCELED fall back to the free tier. A source that cannot answer
 * is `entitlements_unavailable`, never "free tier": not knowing is not the same as not paying.
 */
@Injectable()
export class EntitlementsService {
  constructor(
    private readonly basis: SubscriptionBasisService,
    @Inject(ENTITLEMENT_CACHE) private readonly cache: EntitlementCachePort,
    @Inject(USAGE_STORE) private readonly usage: UsageStorePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async get(
    subjectType: SubjectType,
    subjectId: string,
  ): Promise<Entitlements> {
    return this.counted('get', async () => ({
      ...(await this.entry(subjectType, subjectId)).entitlements,
    }));
  }

  /** Up to 500 distinct ids with one batch call to the basis source; never a call per id (FR-004). */
  async getMany(
    subjectType: SubjectType,
    subjectIds: string[],
  ): Promise<Map<string, Entitlements>> {
    const ids = [...new Set(subjectIds)];
    if (ids.length > MAX_IDS) throw tooManyIds();
    if (ids.length === 0) return new Map();
    const entries = await this.cache.loadMany(
      subjectType,
      ids,
      async (missing) => {
        const live = await this.basis.getLiveBasisBySubjectIds(
          subjectType,
          missing,
        );
        return new Map(
          missing.map((id) => [id, this.entryFrom(subjectType, live.get(id))]),
        );
      },
    );
    return new Map(
      [...entries].map(([id, entry]) => [id, { ...entry.entitlements }]),
    );
  }

  async hasEntitlement(
    subjectType: SubjectType,
    subjectId: string,
    feature: EntitlementKey,
  ): Promise<boolean> {
    assertEntitlementKey(feature);
    return this.counted('has', async () =>
      hasKey((await this.entry(subjectType, subjectId)).entitlements, feature),
    );
  }

  async checkLimit(
    subjectType: SubjectType,
    subjectId: string,
    key: LimitKey,
    current: number,
  ): Promise<LimitStatus> {
    // the key and the value are checked before anything is read
    limitOf({}, key, current);
    return this.counted('limit', async () =>
      limitOf(
        (await this.entry(subjectType, subjectId)).entitlements,
        key,
        current,
      ),
    );
  }

  /**
   * The plan limit against the exact usage of the current UTC calendar month (FR-006). Rejects `usage_unavailable`
   * rather than guess when usage cannot be read; the caller decides to fail open or closed.
   */
  async checkQuota(
    subjectType: SubjectType,
    subjectId: string,
    key: QuotaKey,
    now: Date = this.clock.now(),
  ): Promise<QuotaStatus> {
    const metric = quotaMetric(key);
    return this.counted('quota', async () => {
      const from = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      );
      const resetsAt = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
      );
      const limit = quotaLimit(
        (await this.entry(subjectType, subjectId)).entitlements,
        key,
      );
      const used = await this.usage.total(subjectId, {
        metric,
        from,
        to: resetsAt,
      });
      return {
        allowed: used < limit,
        used,
        limit,
        resetsAt: resetsAt.toISOString(),
      };
    });
  }

  /**
   * Drops the entry after S17 committed a change (FR-011). With the committed `subscription` the drop is version
   * guarded: a load that began before this change and returns the old state never stores. Rejects
   * `entitlement_invalidation_failed` when the entry cannot be dropped (FR-014).
   */
  async invalidate(
    subjectType: SubjectType,
    subjectId: string,
    subscription?: SubscriptionRef,
  ): Promise<void> {
    if (subscription) {
      await this.cache.invalidateIfOlder(
        subjectType,
        subjectId,
        subscription.subscriptionId,
        subscription.subscriptionVersion,
      );
      return;
    }
    await this.cache.invalidate(subjectType, subjectId);
  }

  private entry(
    subjectType: SubjectType,
    subjectId: string,
  ): Promise<CachedEntitlements> {
    return this.cache.load(subjectType, subjectId, async () => {
      const live = await this.basis.getLiveBasisBySubjectIds(subjectType, [
        subjectId,
      ]);
      return this.entryFrom(subjectType, live.get(subjectId));
    });
  }

  /** The cache entry for a basis (or none: the free tier of the subject type). */
  private entryFrom(
    subjectType: SubjectType,
    live:
      | {
          subscriptionId: string;
          subscriptionVersion: number;
          entitlements: Record<string, boolean | number>;
        }
      | undefined,
  ): CachedEntitlements {
    const loadedAt = this.clock.now().toISOString();
    if (!live)
      return {
        entitlements: freeTier(subjectType),
        subscriptionId: null,
        subscriptionVersion: null,
        loadedAt,
      };
    const entitlements: Record<string, boolean | number> = {};
    for (const key of ENTITLEMENT_KEYS)
      if (Object.prototype.hasOwnProperty.call(live.entitlements, key))
        entitlements[key] = live.entitlements[key];
    return {
      entitlements: entitlements as Entitlements,
      subscriptionId: live.subscriptionId,
      subscriptionVersion: live.subscriptionVersion,
      loadedAt,
    };
  }

  private async counted<T>(
    kind: 'get' | 'has' | 'limit' | 'quota',
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await run();
      entitlementChecksCounter.add(1, { kind, outcome: 'ok' });
      return result;
    } catch (error) {
      entitlementChecksCounter.add(1, { kind, outcome: 'unavailable' });
      throw error;
    }
  }
}
