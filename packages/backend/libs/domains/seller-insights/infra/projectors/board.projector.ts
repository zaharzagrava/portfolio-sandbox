import { Inject, Injectable, Logger } from '@nestjs/common';
import { OrderPaid } from '@app/domains/orders';
import { CLOCK, type Clock } from '@app/common/core/clock';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { insightsLog, traceIdOf } from '../../application/insights-log';
import { insightsMetrics } from '../../application/seller-insights.metrics';
import { RevenueLimitExceededError } from '../../domain/errors';
import {
  BOARD_REPOSITORY,
  PRODUCT_CATEGORY_DIRECTORY,
  SNAPSHOT_REPOSITORY,
  type BoardRepository,
  type ProductCategoryDirectory,
  type SnapshotRepository,
} from '../../domain/ports';
import { isClosed, periodsOf, type Period } from '../../domain/periods';
import { boardPlan } from '../../domain/sale-facts';
import {
  batchLagSeconds,
  parsePaid,
  permissive,
  reject,
  storeCall,
} from './support';

export const BOARD_FEED = 'boards';

/**
 * `orders.events` -> the weekly and monthly boards, overall and per category (S40 US1). One order is applied once per
 * period, atomically across the period's boards; `paidAt` decides the periods, a frozen period is acknowledged without
 * being applied. Idempotency: a per-period set of applied order ids inside the board script (`natural`).
 */
@Injectable()
export class BoardProjector implements Projector {
  readonly name = 'seller-insights-boards';
  readonly topics = [OrderPaid.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [permissive(OrderPaid)];

  private readonly logger = new Logger(BoardProjector.name);

  constructor(
    @Inject(BOARD_REPOSITORY) private readonly boards: BoardRepository,
    @Inject(SNAPSHOT_REPOSITORY) private readonly snapshots: SnapshotRepository,
    @Inject(PRODUCT_CATEGORY_DIRECTORY)
    private readonly categories: ProductCategoryDirectory,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    insightsMetrics.lag(
      BOARD_FEED,
      batchLagSeconds(events, this.clock.nowMs()),
    );
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    const orders = events.map((event) => ({
      event,
      order: parsePaid(BOARD_FEED, event),
    }));
    const productIds = [
      ...new Set(orders.flatMap((o) => o.order.lines.map((l) => l.productId))),
    ];
    const categories = await storeCall(() =>
      this.categories.categoriesOf(productIds),
    );

    for (const { event, order } of orders) {
      const plan = boardPlan(order, (id) => categories.get(id));
      if (plan.updates.length === 0) continue;
      const saleAt = new Date(order.paidAt);
      let applied = 0;
      for (const period of Object.values(periodsOf(saleAt))) {
        const outcome = await this.applyTo(period, event, saleAt, plan.updates);
        insightsMetrics.board(outcome);
        counts[outcome === 'sealed' ? 'stale' : outcome]++;
        if (outcome === 'applied') applied++;
      }
      if (applied > 0) {
        if (plan.categoryUnresolved > 0)
          insightsMetrics.board('category_unresolved', plan.categoryUnresolved);
        if (plan.categoryInvalid > 0)
          insightsLog(
            this.logger,
            'warn',
            'category_invalid',
            { traceId: traceIdOf(event.traceparent) ?? event.eventId },
            { orderId: order.orderId, lines: plan.categoryInvalid },
          );
      }
    }
    insightsMetrics.lag(BOARD_FEED, 0);
    return counts;
  }

  private async applyTo(
    period: Period,
    event: EventEnvelope,
    saleAt: Date,
    updates: Parameters<BoardRepository['apply']>[3],
  ): Promise<'applied' | 'duplicate' | 'sealed'> {
    const orderId = (event.payload as { orderId: string }).orderId;
    // A closed period may have been frozen while its flag expired or was lost: the snapshot table is the record.
    if (
      isClosed(period, this.clock.now()) &&
      !(await storeCall(() => this.boards.isSealed(period))) &&
      (await storeCall(() => this.snapshots.isFrozen(period.id)))
    )
      await storeCall(() => this.boards.seal(period));
    let outcome: 'applied' | 'duplicate' | 'sealed';
    try {
      outcome = await storeCall(() =>
        this.boards.apply(period, orderId, saleAt, updates),
      );
    } catch (error) {
      if (error instanceof RevenueLimitExceededError)
        return reject(BOARD_FEED, event, 'revenue_limit_exceeded');
      throw error;
    }
    if (outcome === 'sealed')
      insightsLog(
        this.logger,
        'warn',
        'period_sealed',
        { traceId: traceIdOf(event.traceparent) ?? event.eventId },
        { orderId, period: period.id },
      );
    return outcome;
  }
}
