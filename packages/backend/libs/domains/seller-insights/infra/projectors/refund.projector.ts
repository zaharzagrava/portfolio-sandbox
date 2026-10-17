import { Inject, Injectable } from '@nestjs/common';
import { OrderRefunded } from '@app/domains/orders';
import { sellerInsightsOrderRefundedSchema } from '@marketplace-sandbox/contracts';
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
import {
  batchLagSeconds,
  parseOrReject,
  permissive,
  PLATFORM_CURRENCY,
  reject,
  storeCall,
} from './support';

export const REFUND_FEED = 'refunds';

/**
 * `order.refunded` -> one refund fact per shop, split by the shares the shop recorded for the order (S40 US6, R-7). A
 * refund that arrives before its sale is tried again (5 attempts with backoff) and then dead-lettered; a partial amount
 * is dead-lettered at once in effect (it can never match). Refunds never touch the boards or the live counters.
 */
@Injectable()
export class RefundProjector implements Projector {
  readonly name = 'seller-insights-refunds';
  readonly topics = [OrderRefunded.topic];
  readonly idempotency = 'natural' as const;
  readonly attempts = 5;
  readonly handles = [permissive(OrderRefunded)];

  constructor(
    @Inject(SALES_HISTORY_REPOSITORY)
    private readonly history: SalesHistoryRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    insightsMetrics.lag(
      REFUND_FEED,
      batchLagSeconds(events, this.clock.nowMs()),
    );
    for (const event of events) {
      const refund = parseOrReject(
        REFUND_FEED,
        event,
        sellerInsightsOrderRefundedSchema,
      );
      if (refund.currency !== PLATFORM_CURRENCY)
        reject(REFUND_FEED, event, 'unsupported_currency');
      const shares = await storeCall(() =>
        this.history.recordedShares(refund.orderId),
      );
      if (shares.length === 0)
        reject(REFUND_FEED, event, 'refund_without_sale');
      const recorded = shares.reduce((n, s) => n + s.amountMinor, 0);
      if (recorded !== refund.amountMinor)
        reject(REFUND_FEED, event, 'partial_refund_unsupported');
      await storeCall(() =>
        this.history.insertRefunds(
          shares.map((s) => ({
            shopId: s.shopId,
            orderId: refund.orderId,
            amountMinor: s.amountMinor,
            refundedAt: new Date(event.occurredAt),
          })),
        ),
      );
    }
    insightsMetrics.lag(REFUND_FEED, 0);
    return { applied: events.length, duplicate: 0, stale: 0 };
  }
}
