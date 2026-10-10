import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  ORDER_REPOSITORY,
  RESERVATION_SOURCE,
  type OrderRecord,
  type OrderRepository,
  type ReservationSource,
} from '../domain/ports';
import {
  buildReleaseOperations,
  buildReserveOperations,
  type StockLine,
} from '../domain/stock-operations';
import { OrderLifecycleService } from './order-lifecycle.service';

export type ReserveOutcome =
  | { kind: 'reserved'; order: OrderRecord }
  /** The catalog refused: the order is now `CANCELLED(out_of_stock)` and nothing was held. */
  | { kind: 'rejected'; insufficient: string[]; unavailable: string[] }
  /** The order left `PENDING` by another path (cancelled meanwhile): any stock this call took was returned. */
  | { kind: 'gone' };

/**
 * The stock step of the checkout saga (S10 D-4): one catalog command for the whole order, outside any transaction of
 * ours, then the `PENDING → RESERVED` move. Used by checkout and by the recovery job; both send the same operation ids,
 * so repeating the step is a no-op in the catalog. An unknown outcome (timeout, crash) throws and leaves the order
 * `PENDING` for the recovery job.
 */
@Injectable()
export class OrderReservationService {
  private readonly logger = new Logger(OrderReservationService.name);

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(RESERVATION_SOURCE) private readonly source: ReservationSource,
    private readonly lifecycle: OrderLifecycleService,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async reserve(orderId: string, actor: string): Promise<ReserveOutcome> {
    const order = await this.orders.findById(orderId);
    if (!order) return { kind: 'gone' };
    if (order.status !== 'PENDING')
      return order.status === 'CANCELLED'
        ? { kind: 'gone' }
        : { kind: 'reserved', order };

    const lines = await this.stockLines(orderId);
    const outcome = await this.source.reserve(
      buildReserveOperations(orderId, lines),
    );

    if (outcome.outcome === 'rejected') {
      await this.lifecycle.transition(
        orderId,
        { type: 'cancel', reason: 'out_of_stock' },
        { actor },
      );
      return {
        kind: 'rejected',
        insufficient: outcome.insufficient,
        unavailable: outcome.unavailable,
      };
    }

    const moved = await this.lifecycle.transition(
      orderId,
      { type: 'reserve' },
      {
        actor,
        reservedUntil: new Date(
          this.clock.now().getTime() +
            this.config.get('orders_hold_seconds') * 1000,
        ),
      },
    );
    if (moved.kind === 'applied' || moved.kind === 'already_applied')
      return { kind: 'reserved', order: moved.order };
    // A concurrent run (checkout and recovery, two recoveries) reserved it first: its stock is ours too, keep it.
    if (moved.kind === 'invalid' && moved.order.status !== 'CANCELLED')
      return { kind: 'reserved', order: moved.order };

    // The stock is taken but the order cannot be reserved (it was cancelled by another path): give it back.
    try {
      await this.source.release(buildReleaseOperations(orderId, lines));
    } catch (error) {
      this.logger.error(
        `order ${orderId} was cancelled after its stock was taken and the release failed: ${(error as Error).name}`,
      );
    }
    return { kind: 'gone' };
  }

  private async stockLines(orderId: string): Promise<StockLine[]> {
    const items = await this.orders.items(orderId);
    return items.map((i) => ({
      productId: i.productId,
      shopId: i.shopId!,
      quantity: i.quantity,
    }));
  }
}
