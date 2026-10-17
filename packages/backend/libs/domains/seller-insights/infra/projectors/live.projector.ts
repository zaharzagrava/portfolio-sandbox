import { Inject, Injectable } from '@nestjs/common';
import { OrderPaid, OrderReserved } from '@app/domains/orders';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { sellerInsightsOrderReservedSchema } from '@marketplace-sandbox/contracts';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { insightsMetrics } from '../../application/seller-insights.metrics';
import {
  LIVE_COUNTER_REPOSITORY,
  type LiveCounterRepository,
} from '../../domain/ports';
import { shopTotals } from '../../domain/sale-facts';
import {
  batchLagSeconds,
  parseOrReject,
  parsePaid,
  permissive,
  storeCall,
} from './support';
import { LIVE_WINDOW_SECONDS } from '../redis-live-counter.repository';

export const LIVE_FEED = 'live';

/**
 * `orders.events` -> the per-second counters of the live dashboard (S40 US5): checkouts from `order.reserved` (once per shop
 * per reservation), orders, units and revenue from `order.paid` (once per shop per order), keyed by the event's own second.
 * An event older than the 60 s window changes nothing here (it still reaches the sales history). The mark and the
 * increments are one atomic step in the store, so a failed attempt is simply retried.
 */
@Injectable()
export class LiveProjector implements Projector {
  readonly name = 'seller-insights-live';
  readonly topics = [OrderPaid.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [permissive(OrderPaid), permissive(OrderReserved)];

  constructor(
    @Inject(LIVE_COUNTER_REPOSITORY)
    private readonly counters: LiveCounterRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const nowMs = this.clock.nowMs();
    insightsMetrics.lag(LIVE_FEED, batchLagSeconds(events, nowMs));
    const nowSecond = Math.floor(nowMs / 1000);
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };

    // Validate the whole batch first: nothing is counted for a batch that carries a message that cannot be applied.
    const work = events.map((event) => {
      if (event.type === OrderReserved.type) {
        const reserved = parseOrReject(
          LIVE_FEED,
          event,
          sellerInsightsOrderReservedSchema,
        );
        return { event, kind: 'reserved' as const, reserved };
      }
      return {
        event,
        kind: 'paid' as const,
        order: parsePaid(LIVE_FEED, event),
      };
    });

    for (const item of work) {
      const { event } = item;
      if (item.kind === 'reserved') {
        const second = Math.floor(Date.parse(event.occurredAt) / 1000);
        if (nowSecond - second >= LIVE_WINDOW_SECONDS) {
          insightsMetrics.live('stale');
          counts.stale++;
          continue;
        }
        const shopIds = new Set<string>();
        for (const id of item.reserved.shopIds)
          if (id) shopIds.add(id);
          else insightsMetrics.live('shop_missing');
        for (const shopId of shopIds)
          this.note(
            counts,
            await storeCall(() =>
              this.counters.apply(
                event.eventId,
                'reserved',
                second,
                nowSecond,
                {
                  shopId,
                  checkouts: 1,
                },
              ),
            ),
          );
      } else {
        const second = Math.floor(Date.parse(item.order.paidAt) / 1000);
        if (nowSecond - second >= LIVE_WINDOW_SECONDS) {
          insightsMetrics.live('stale');
          counts.stale++;
          continue;
        }
        for (const totals of shopTotals(item.order))
          this.note(
            counts,
            await storeCall(() =>
              this.counters.apply(event.eventId, 'paid', second, nowSecond, {
                shopId: totals.shopId,
                orders: 1,
                units: totals.units,
                revenueMinor: totals.revenueMinor,
              }),
            ),
          );
      }
    }
    insightsMetrics.lag(LIVE_FEED, 0);
    return counts;
  }

  private note(counts: SinkCounts, outcome: 'applied' | 'duplicate' | 'stale') {
    if (outcome !== 'stale') insightsMetrics.live(outcome);
    counts[outcome]++;
  }
}
