import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CLOCK, Clock } from '@app/common/core/clock';
import { OrderCancelled, OrderPaid } from '@app/domains/orders';
import { ShopDeleted } from '@app/domains/tenancy';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { DeliveryActionsService } from '../application/delivery-actions.service';
import {
  DELIVERABLE_ORDER_STORE,
  type DeliverableOrderStore,
} from '../domain/delivery-ports';

/**
 * `order.paid` -> the fulfilment-owned copy of the order (S20 FR-045, AS-55, AS-56, R-12): buyer = `userId`, shops = the
 * distinct non-null `shopOrders[].shopId`, guarded by `orderVersion` in the statement (higher wins, equal or lower and
 * a cancelled copy are ignored), so a duplicate or reordered delivery is harmless. The framework validates the envelope
 * and the payload against the S10 contract; a payload that fails (missing `orderId`, `shopOrders` not an array, unknown
 * event version) is dead-lettered with a reason before `project` runs. Its own consumer group.
 */
@Injectable()
export class DeliveryOrderPaidProjector implements Projector {
  readonly name: string = 'delivery-order-paid';
  readonly topics: string[] = [OrderPaid.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: OrderPaid }];
  readonly aggregateIdSchema = z.string().uuid();

  constructor(
    @Inject(DELIVERABLE_ORDER_STORE)
    private readonly orders: DeliverableOrderStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const total: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    for (const envelope of events) {
      const event = OrderPaid.match(envelope);
      if (!event) continue;
      const { orderId, userId, currency, orderVersion, shopOrders } =
        event.payload;
      const shopIds = [
        ...new Set(
          shopOrders
            .map((shopOrder) => shopOrder.shopId)
            .filter((shopId): shopId is string => shopId !== null)
            .map((shopId) => shopId.toLowerCase()),
        ),
      ];
      const result = await this.orders.applyPaid(
        { orderId, buyerId: userId, shopIds, currency, orderVersion },
        this.clock.now(),
      );
      if (result === 'applied') total.applied++;
      else total.duplicate++;
    }
    return total;
  }
}

/**
 * `order.cancelled` -> every open delivery of the order is cancelled with reason `order_cancelled` (S20 FR-027, AS-35),
 * with the same effects as a shop's cancel; a delivery already on its way is flagged by a history note, not cancelled.
 * Its own consumer group. The framework validates the envelope and the payload (poison and unknown versions are
 * dead-lettered with a reason before this runs). Idempotent by the state itself: a redelivery finds nothing open (and
 * the note is written once), so a duplicate has no further effect. The copy of the order that `order.paid` builds is
 * updated here too (`CANCELLED` at the event's version, buyer = the event's user), so a cancel that arrives before the
 * payment sticks (AS-56).
 */
@Injectable()
export class DeliveryOrderCancelledProjector implements Projector {
  readonly name: string = 'delivery-order-cancelled';
  readonly topics: string[] = [OrderCancelled.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: OrderCancelled }];
  readonly aggregateIdSchema = z.string().uuid();

  constructor(
    private readonly actions: DeliveryActionsService,
    @Inject(DELIVERABLE_ORDER_STORE)
    private readonly orders: DeliverableOrderStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const total: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    for (const envelope of events) {
      const event = OrderCancelled.match(envelope);
      if (!event) continue;
      const copy = await this.orders.applyCancelled(
        {
          orderId: event.payload.orderId,
          buyerId: event.payload.userId,
          orderVersion: event.payload.orderVersion,
        },
        this.clock.now(),
      );
      const { cancelled, flagged } = await this.actions.cancelByOrder(
        event.payload.orderId,
      );
      if (cancelled + flagged > 0 || copy === 'applied') total.applied++;
      else total.duplicate++;
    }
    return total;
  }
}

/**
 * `tenancy.shop_deleted` -> every open delivery of the shop is cancelled with reason `shop_deleted` (FR-027, AS-35); one
 * in transit is flagged. The rows stay (buyers and couriers keep reading their deliveries). Own consumer group.
 */
@Injectable()
export class DeliveryShopDeletedProjector implements Projector {
  readonly name: string = 'delivery-shop-deleted';
  readonly topics: string[] = [ShopDeleted.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: ShopDeleted }];
  readonly aggregateIdSchema = z.string().uuid();

  constructor(private readonly actions: DeliveryActionsService) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const total: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    for (const envelope of events) {
      const event = ShopDeleted.match(envelope);
      if (!event) continue;
      const { cancelled, flagged } = await this.actions.cancelByShopDeleted(
        event.payload.shopId,
      );
      if (cancelled + flagged > 0) total.applied++;
      else total.duplicate++;
    }
    return total;
  }
}
