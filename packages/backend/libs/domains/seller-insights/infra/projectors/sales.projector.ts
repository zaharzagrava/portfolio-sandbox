import { Inject, Injectable } from '@nestjs/common';
import { OrderPaid } from '@app/domains/orders';
import { CLOCK, type Clock } from '@app/common/core/clock';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { insightsMetrics } from '../../application/seller-insights.metrics';
import {
  SALES_HISTORY_REPOSITORY,
  type SalesHistoryRepository,
} from '../../domain/ports';
import { saleRows } from '../../domain/sale-facts';
import { batchLagSeconds, parsePaid, permissive, storeCall } from './support';

export const SALES_FEED = 'sales';

/**
 * `orders.events` -> the exact sales history that "today" and stats read (S40 US6). One fact per (shop, order, product),
 * written again on every delivery: the history engine keeps the latest version of each key, so a redelivery, a replay or
 * an order split over two batches changes nothing (`natural`).
 */
@Injectable()
export class SalesProjector implements Projector {
  readonly name = 'seller-insights-sales';
  readonly topics = [OrderPaid.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [permissive(OrderPaid)];

  constructor(
    @Inject(SALES_HISTORY_REPOSITORY)
    private readonly history: SalesHistoryRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    insightsMetrics.lag(
      SALES_FEED,
      batchLagSeconds(events, this.clock.nowMs()),
    );
    const rows = events.flatMap((event) =>
      saleRows(parsePaid(SALES_FEED, event)),
    );
    if (rows.length > 0) await storeCall(() => this.history.insertSales(rows));
    insightsMetrics.lag(SALES_FEED, 0);
    return { applied: events.length, duplicate: 0, stale: 0 };
  }
}
