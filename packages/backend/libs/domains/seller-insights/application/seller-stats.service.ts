import { Inject, Injectable } from '@nestjs/common';
import type { SellerStats } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { averageOrderValue } from '../domain/average-order-value';
import { AnalyticsStoreUnavailableError } from '../domain/errors';
import { insightsUnavailable } from '../domain/insights-errors';
import {
  SALES_HISTORY_REPOSITORY,
  type SalesHistoryRepository,
  type SalesWindow,
} from '../domain/ports';

const DAY_MS = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * A shop's figures over the last N UTC calendar days ending today (S40 US6): summary, a zero-filled daily series and
 * the five best products, from the exact sales history. The answer never names a buyer.
 */
@Injectable()
export class SellerStatsService {
  constructor(
    @Inject(SALES_HISTORY_REPOSITORY)
    private readonly history: SalesHistoryRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async stats(shopId: string, days: number): Promise<SellerStats> {
    const today = Math.floor(this.clock.nowMs() / DAY_MS) * DAY_MS;
    const first = today - (days - 1) * DAY_MS;
    let window: SalesWindow;
    try {
      window = await this.history.window(
        shopId,
        new Date(first),
        new Date(today + DAY_MS),
      );
    } catch (error) {
      if (error instanceof AnalyticsStoreUnavailableError)
        throw insightsUnavailable();
      throw error;
    }
    const byDay = new Map(window.daily.map((d) => [d.day, d]));
    const daily = Array.from({ length: days }, (_, i) => {
      const day = dayOf(first + i * DAY_MS);
      const point = byDay.get(day);
      return {
        day,
        revenueMinor: point?.revenueMinor ?? 0,
        orders: point?.orders ?? 0,
        refundedMinor: point?.refundedMinor ?? 0,
      };
    });
    return {
      shopId,
      days,
      from: dayOf(first),
      to: dayOf(today),
      currency: 'EUR',
      summary: {
        revenueMinor: window.revenueMinor,
        orders: window.orders,
        unitsSold: window.unitsSold,
        uniqueBuyers: window.uniqueBuyers,
        refundsCount: window.refundsCount,
        refundedMinor: window.refundedMinor,
        netRevenueMinor: window.revenueMinor - window.refundedMinor,
        avgOrderValueMinor: averageOrderValue(
          window.revenueMinor,
          window.orders,
        ),
      },
      daily,
      topProducts: window.topProducts,
    };
  }
}
