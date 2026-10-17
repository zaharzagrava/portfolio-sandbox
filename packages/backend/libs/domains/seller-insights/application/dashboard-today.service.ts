import { Inject, Injectable } from '@nestjs/common';
import type { DashboardToday } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { AnalyticsStoreUnavailableError } from '../domain/errors';
import { insightsUnavailable } from '../domain/insights-errors';
import { isoSeconds } from '../domain/periods';
import {
  SALES_HISTORY_REPOSITORY,
  type SalesHistoryRepository,
} from '../domain/ports';

const DAY_MS = 86_400_000;

/** Today's totals and per-minute series for one shop, from the exact sales history (S40 FR-034); never from order tables. */
@Injectable()
export class DashboardTodayService {
  constructor(
    @Inject(SALES_HISTORY_REPOSITORY)
    private readonly history: SalesHistoryRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async today(shopId: string): Promise<DashboardToday> {
    const now = this.clock.nowMs();
    const start = new Date(Math.floor(now / DAY_MS) * DAY_MS);
    const end = new Date(start.getTime() + DAY_MS);
    try {
      const today = await this.history.today(shopId, start, end);
      return {
        day: start.toISOString().slice(0, 10),
        totals: {
          orders: today.orders,
          units: today.units,
          revenueMinor: today.revenueMinor,
        },
        series: today.series.map((p) => ({
          minute: isoSeconds(p.minute),
          orders: p.orders,
          units: p.units,
          revenueMinor: p.revenueMinor,
        })),
      };
    } catch (error) {
      if (error instanceof AnalyticsStoreUnavailableError)
        throw insightsUnavailable();
      throw error;
    }
  }
}
