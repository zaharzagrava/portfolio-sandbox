import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { RequestLogStore } from '../domain/ports';

const DAY_MS = 86_400_000;

/**
 * Which versions and routes a shop's keys use (FR-057, FR-033, AS-63, AS-35): rows per day, version and route, and the
 * same per key with the last call, so the shop (and the platform owner) can see who still calls what is going away.
 */
@Injectable()
export class UsageReportService {
  constructor(
    private readonly store: RequestLogStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async report(
    shopId: string,
    q: { days: number; livemode: boolean; deprecated: boolean },
  ) {
    const now = this.clock.now();
    const startOfToday = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const query = {
      from: new Date(startOfToday - (q.days - 1) * DAY_MS),
      livemode: q.livemode,
      deprecatedOnly: q.deprecated,
    };
    const [days, keys] = await Promise.all([
      this.store.usageByDay(shopId, query),
      this.store.usageByKey(shopId, query),
    ]);
    return { days, keys };
  }
}
