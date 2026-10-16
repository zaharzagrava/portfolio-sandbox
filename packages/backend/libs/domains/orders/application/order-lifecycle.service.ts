import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  decide,
  type OrderCommand,
  type OrderStatus,
} from '../domain/order-state';
import {
  ORDER_HISTORY_REPOSITORY,
  ORDER_REPOSITORY,
  REALTIME_PORT,
  RESERVATION_REPOSITORY,
  SHOP_ORDER_REPOSITORY,
  type OrderHistoryRepository,
  type OrderRecord,
  type OrderRepository,
  type RealtimePort,
  type ReservationRepository,
  type ShopOrderRepository,
} from '../domain/ports';
import {
  FLASH_RESERVATION,
  type FlashReservationPort,
} from '../domain/flash-ports';
import {
  OrderCancelled,
  OrderFulfilmentChanged,
  OrderPaid,
  OrderRefunded,
  OrderReserved,
} from './events/order-events';
import { orderPaidCounter } from '../domain/order-metrics';
import { ReservationReleaseService } from './reservation-release.service';

import './order.job-types';

export type TransitionResult =
  | { kind: 'applied'; order: OrderRecord; previous: OrderStatus }
  | { kind: 'already_applied'; order: OrderRecord }
  | { kind: 'invalid'; order: OrderRecord }
  | { kind: 'not_found' };

export interface TransitionContext {
  /** Who moved the order: `user:<id>`, `system:expiry`, `system:webhook`, `system:consumer`, `system:checkout`, ... */
  actor: string;
  /** Required by `reserve`: the end of the hold. */
  reservedUntil?: Date;
}

const MAX_RACE_ATTEMPTS = 3;

/**
 * The only writer of order state (S10 FR-033, FR-034). A move is a conditional update (`… WHERE id AND status = :from`),
 * so concurrent or repeated triggers (checkout, webhook, payment consumer, expiry, buyer cancel, fulfilment) cannot
 * apply it twice: the loser matches no row and gets `already_applied` or `invalid`. History row, version step, outbox
 * event, shop-order and reservation propagation and the expiry job commit in one transaction; the realtime push and
 * the immediate stock release follow the commit.
 */
@Injectable()
export class OrderLifecycleService {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(SHOP_ORDER_REPOSITORY)
    private readonly shopOrders: ShopOrderRepository,
    @Inject(RESERVATION_REPOSITORY)
    private readonly reservations: ReservationRepository,
    @Inject(ORDER_HISTORY_REPOSITORY)
    private readonly history: OrderHistoryRepository,
    @Inject(REALTIME_PORT) private readonly realtime: RealtimePort,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly jobs: JobsService,
    private readonly release: ReservationReleaseService,
    @Inject(FLASH_RESERVATION) private readonly flash: FlashReservationPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private readonly logger = new Logger(OrderLifecycleService.name);

  async transition(
    orderId: string,
    command: OrderCommand,
    context: TransitionContext,
  ): Promise<TransitionResult> {
    const result = await this.runner.run(() =>
      this.applyInTransaction(orderId, command, context),
    );
    if (result.kind === 'applied') {
      await this.realtime.pushOrderStatus(
        result.order.userId,
        orderId,
        result.order.status,
      );
      // A cancel from PENDING can hold drop units too (claimed before the order existed): give them back right away.
      if (
        command.type === 'cancel' &&
        (result.previous === 'RESERVED' || result.previous === 'PENDING')
      )
        await this.release.releaseOrder(orderId);
      if (command.type === 'markPaid') {
        orderPaidCounter.add();
        await this.convertFlashHolds(orderId);
      }
    }
    return result;
  }

  /**
   * After the commit that made the order `PAID` (its drop rows are `CONVERTED`): the claims become permanent. Outside
   * the transaction (a fast-store call); a failure is logged, never fatal: the durable rows already say sold, and the
   * reconciliation counts them (S11 FR-023).
   */
  private async convertFlashHolds(orderId: string): Promise<void> {
    try {
      const rows = (await this.reservations.forOrder(orderId)).filter(
        (r) => r.source === 'FLASH' && r.status === 'CONVERTED',
      );
      for (const r of rows) {
        const answer = await this.flash.convertReservation({
          id: r.id,
          orderId,
          productId: r.productId,
          quantity: r.quantity,
          status: r.status,
          sourceRef: r.sourceRef as string,
          flashSaleId: r.flashSaleId as string,
        });
        if (answer === 'not_held')
          this.logger.warn(
            `order ${orderId}: paid, but the claim of its drop units was not held any more`,
          );
      }
    } catch (error) {
      this.logger.warn(
        `order ${orderId}: conversion of drop units failed (${(error as Error).name}); the durable rows stand`,
      );
    }
  }

  /** Runs inside the caller's transaction when there is one (checkout joins its own writes to the first move). */
  async applyInTransaction(
    orderId: string,
    command: OrderCommand,
    context: TransitionContext,
  ): Promise<TransitionResult> {
    for (let attempt = 0; attempt < MAX_RACE_ATTEMPTS; attempt++) {
      const current = await this.orders.findById(orderId);
      if (!current) return { kind: 'not_found' };
      const decision = decide(current.status, command);
      if (decision.kind === 'already_applied')
        return { kind: 'already_applied', order: current };
      if (decision.kind === 'invalid')
        return { kind: 'invalid', order: current };

      const now = this.clock.now();
      const updated = await this.orders.move(
        orderId,
        current.status,
        decision.to,
        this.patchFor(command, context),
        now,
      );
      if (!updated) continue; // lost the race: decide again against the new status

      await this.history.append({
        orderId,
        from: current.status,
        to: decision.to,
        reason: this.reasonFor(command),
        actor: context.actor,
        at: now,
      });
      await this.propagate(updated, current.status, command, now);
      return { kind: 'applied', order: updated, previous: current.status };
    }
    const latest = await this.orders.findById(orderId);
    return latest ? { kind: 'invalid', order: latest } : { kind: 'not_found' };
  }

  private patchFor(command: OrderCommand, context: TransitionContext) {
    switch (command.type) {
      case 'reserve':
        return { reservedUntil: context.reservedUntil ?? null };
      case 'cancel':
        return { cancelReason: command.reason };
      case 'markPaid':
        return { paymentRef: command.paymentRef };
      default:
        return {};
    }
  }

  private reasonFor(command: OrderCommand): string | null {
    switch (command.type) {
      case 'cancel':
        return command.reason;
      case 'markPaid':
        return 'payment_confirmed';
      case 'refund':
        return command.reason;
      case 'ship':
        return `tracking:${command.trackingCode}`;
      default:
        return null;
    }
  }

  /** Shop orders, reservations, outbox event and delayed job of one applied move. */
  private async propagate(
    order: OrderRecord,
    previous: OrderStatus,
    command: OrderCommand,
    now: Date,
  ): Promise<void> {
    const base = {
      orderId: order.id,
      userId: order.userId,
      orderVersion: order.version,
    };
    switch (command.type) {
      case 'reserve': {
        const until = order.reservedUntil!;
        await this.reservations.transitionAll(order.id, ['REQUESTED'], 'HELD', {
          expiresAt: until,
        });
        const shops = await this.shopOrders.forOrder(order.id);
        await this.outbox.append(
          OrderReserved.create(order.id, order.version, {
            ...base,
            totalMinor: order.totalMinor,
            currency: order.currency,
            shopIds: shops.map((s) => s.shopId),
            reservedUntil: until.toISOString(),
          }),
        );
        await this.jobs.enqueue(
          'orders.expire-reservation',
          { orderId: order.id },
          { runAt: until, idempotencyKey: `order-expire:${order.id}` },
        );
        return;
      }
      case 'cancel': {
        await this.shopOrders.setStatus(order.id, 'CANCELLED', now);
        if (previous === 'PENDING') {
          await this.reservations.transitionAll(
            order.id,
            ['REQUESTED'],
            'RELEASED',
            {
              nextReleaseAt: null,
            },
          );
          // Drop units are claimed (and the row held) before the order is reserved: they go back through the release.
          await this.reservations.transitionAll(
            order.id,
            ['HELD'],
            'RELEASE_PENDING',
            { nextReleaseAt: now },
          );
        } else
          await this.reservations.transitionAll(
            order.id,
            ['REQUESTED', 'HELD'],
            'RELEASE_PENDING',
            { nextReleaseAt: now },
          );
        await this.outbox.append(
          OrderCancelled.create(order.id, order.version, {
            ...base,
            reason: command.reason,
            previousStatus: previous,
          }),
        );
        return;
      }
      case 'markPaid': {
        await this.reservations.transitionAll(order.id, ['HELD'], 'CONVERTED');
        await this.shopOrders.setStatus(order.id, 'PAID', now);
        const [items, shops] = await Promise.all([
          this.orders.items(order.id),
          this.shopOrders.forOrder(order.id),
        ]);
        await this.outbox.append(
          OrderPaid.create(order.id, order.version, {
            ...base,
            totalMinor: order.totalMinor,
            currency: order.currency,
            paymentRef: command.paymentRef,
            paidAt: now.toISOString(),
            lines: items.map((i) => ({
              ...(i.lineId ? { lineId: i.lineId } : {}),
              ...(i.category ? { category: i.category } : {}),
              productId: i.productId,
              shopId: i.shopId,
              title: i.title ?? '',
              quantity: i.quantity,
              unitPriceMinor: i.unitPriceMinor,
              discountMinor: i.discountMinor,
              lineTotalMinor: i.lineTotalMinor ?? i.unitPriceMinor * i.quantity,
            })),
            shopOrders: shops.map((s) => ({
              shopOrderId: s.id,
              shopId: s.shopId,
              subtotalMinor: s.subtotalMinor,
            })),
          }),
        );
        return;
      }
      case 'refund': {
        await this.shopOrders.setStatus(order.id, 'REFUNDED', now);
        await this.outbox.append(
          OrderRefunded.create(order.id, order.version, {
            ...base,
            amountMinor: order.totalMinor,
            currency: order.currency,
            reason: command.reason,
          }),
        );
        return;
      }
      case 'startFulfilment':
      case 'ship':
      case 'deliver': {
        const status =
          command.type === 'startFulfilment'
            ? 'FULFILLING'
            : command.type === 'ship'
              ? 'SHIPPED'
              : 'DELIVERED';
        await this.outbox.append(
          OrderFulfilmentChanged.create(order.id, order.version, {
            ...base,
            status,
            ...(command.type === 'ship' && {
              trackingCode: command.trackingCode,
            }),
          }),
        );
        return;
      }
    }
  }
}
