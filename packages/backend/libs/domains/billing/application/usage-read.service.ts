import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { validationFailed } from '../domain/errors';
import {
  QUOTA_METRICS,
  quotaLimit,
  type QuotaKey,
} from '../domain/entitlements';
import { USAGE_STORE, type UsageStorePort } from '../domain/ports';
import type { SubjectType } from '../domain/types';
import { EntitlementsService } from './entitlements.service';

export interface UsageMetricRead {
  metric: string;
  used: number;
  limit: number | null;
  remaining: number | null;
}

export interface UsageSummary {
  month: string;
  periodStart: Date;
  periodEnd: Date;
  asOf: Date;
  metrics: UsageMetricRead[];
}

/** How far back a month can be asked for (S18 FR-034, LOCAL: the support window). */
const MONTHS_BACK = 12;

const monthIndex = (date: Date) =>
  date.getUTCFullYear() * 12 + date.getUTCMonth();

/**
 * A subject's monthly usage against its plan (S18 FR-034 to FR-037). The subject comes from the caller (the shop the
 * guard proved membership of, or the session's user), never from the request. Reads are exact; when usage cannot be
 * read the call rejects `usage_unavailable` and nothing partial is returned.
 */
@Injectable()
export class UsageReadService {
  constructor(
    @Inject(USAGE_STORE) private readonly store: UsageStorePort,
    private readonly entitlements: EntitlementsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async summary(
    subjectType: SubjectType,
    subjectId: string,
    month?: string,
  ): Promise<UsageSummary> {
    const now = this.clock.now();
    const current = monthIndex(now);
    let index = current;
    if (month !== undefined) {
      const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
      if (!match) throw validationFailed(['month']);
      index = Number(match[1]) * 12 + (Number(match[2]) - 1);
    }
    if (index > current || index < current - MONTHS_BACK)
      throw validationFailed(['month']);

    const periodStart = new Date(
      Date.UTC(Math.floor(index / 12), index % 12, 1),
    );
    const periodEnd = new Date(
      Date.UTC(Math.floor((index + 1) / 12), (index + 1) % 12, 1),
    );
    const [limits, used] = await Promise.all([
      this.entitlements.get(subjectType, subjectId),
      this.store.totalsByMetric(subjectId, periodStart, periodEnd),
    ]);

    const limitOf = new Map<string, number>();
    for (const key of Object.keys(QUOTA_METRICS) as QuotaKey[])
      limitOf.set(QUOTA_METRICS[key], quotaLimit(limits, key));
    const names = [...new Set([...limitOf.keys(), ...used.keys()])].sort();
    return {
      month: `${periodStart.getUTCFullYear()}-${String(periodStart.getUTCMonth() + 1).padStart(2, '0')}`,
      periodStart,
      periodEnd,
      asOf: now,
      metrics: names.map((metric) => {
        const total = used.get(metric) ?? 0;
        const limit = limitOf.get(metric);
        return {
          metric,
          used: total,
          limit: limit ?? null,
          remaining: limit === undefined ? null : Math.max(0, limit - total),
        };
      }),
    };
  }
}
