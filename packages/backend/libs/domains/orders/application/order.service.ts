import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/sequelize';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import BisOrder from '../infra/models/bis-order.model';
import StockReservation from '../infra/models/stock-reservation.model';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { RealtimePublisher } from '@app/infrastructure/realtime/realtime-publisher.service';
import { FlashStockService } from '../infra/flash-stock.service';
import {
  OrderCommand,
  OrderStatus,
  transitionFor,
} from '../domain/order-state';
import { OrderCancelled, OrderPaid } from './events/order-events';

/**
 * Guarded state transitions (lesson 10/07 #19): every change is
 * `UPDATE ... WHERE status IN (<allowed from>)` + an OrderEvent row + a domain
 * event in the SAME transaction. Concurrent or duplicated triggers (webhook +
 * Kafka consumer + expiry job racing) can't apply a transition twice: the
 * loser's UPDATE matches 0 rows and is treated as already-done or rejected.
 */
@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    @InjectModel(BisOrder) private readonly orderModel: typeof BisOrder,
    @InjectModel(StockReservation)
    private readonly reservationModel: typeof StockReservation,
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly tx: TransactionRunner,
    private readonly events: OutboxService,
    private readonly flash: FlashStockService,
    private readonly realtime: RealtimePublisher,
  ) {}

  /** Returns the new version, or null if the order is already in the target state (idempotent no-op). */
  async transition(
    orderId: string,
    command: OrderCommand,
    reason: string | null,
    transaction: Transaction,
  ): Promise<number | null> {
    const { from, to } = transitionFor(command);
    const rows = await this.sequelize.query<{
      version: number;
      previous: OrderStatus;
    }>(
      `UPDATE "BisOrder" o SET status = :to, version = o.version + 1, "updatedAt" = now()
         ${command.type === 'cancel' ? `, "cancelReason" = :reason` : ''}
       FROM (SELECT id, status AS previous FROM "BisOrder" WHERE id = :orderId FOR UPDATE) p
       WHERE o.id = p.id AND p.previous IN (:from)
       RETURNING o.version, p.previous`,
      {
        type: QueryTypes.SELECT,
        replacements: { to, from, orderId, reason },
        transaction,
      },
    );

    if (rows.length === 0) {
      const current = await this.orderModel.findByPk(orderId, {
        transaction,
        attributes: ['status'],
      });
      if (!current) throw new NotFoundException(`Order ${orderId} not found`);
      if (current.status === to) return null;
      throw new ConflictException(
        `Order ${orderId} is ${current.status}; cannot ${command.type}`,
      );
    }

    await this.sequelize.query(
      `INSERT INTO "OrderEvent" ("bisOrderId", "fromStatus", "toStatus", "reason") VALUES (:orderId, :from, :to, :reason)`,
      {
        replacements: { orderId, from: rows[0].previous, to, reason },
        transaction,
      },
    );
    return rows[0].version;
  }

  /** Payment confirmed (Kafka payments.responses or Stripe webhook - whichever arrives first wins). */
  async markPaid(orderId: string, paymentId: string): Promise<boolean> {
    const applied = await this.tx.run(async (transaction) => {
      const version = await this.transition(
        orderId,
        { type: 'markPaid', paymentId },
        null,
        transaction,
      );
      if (version === null) return false;

      await this.reservationModel.update(
        { status: 'CONVERTED' },
        { where: { bisOrderId: orderId, status: 'HELD' }, transaction },
      );
      const order = await this.orderModel.findByPk(orderId, {
        include: ['items'],
        transaction,
      });
      await this.events.append(
        OrderPaid.create(orderId, version, {
          userId: order!.userId,
          total: Number(order!.total),
          currency: order!.currency,
          paymentId,
          lines: order!.items.map((i) => ({
            productId: i.productId,
            shopId: i.shopId,
            quantity: i.quantity,
            price: Number(i.priceAtPurchase),
          })),
        }),
        transaction,
      );
      return true;
    });
    if (applied) await this.notify(orderId, 'PAID');
    return applied;
  }

  /**
   * Compensation: release every HELD reservation. Postgres stock comes back in
   * the same transaction; flash units go back to their Redis bucket after
   * commit (if Redis fails here, the post-sale reconciliation still corrects it).
   */
  async cancel(
    orderId: string,
    reason:
      'payment_failed' | 'hold_expired' | 'user_cancelled' | 'out_of_stock',
  ): Promise<boolean> {
    const released = await this.tx.run(async (transaction) => {
      const version = await this.transition(
        orderId,
        { type: 'cancel', reason },
        reason,
        transaction,
      );
      if (version === null) return null;

      const held = await this.reservationModel.findAll({
        where: { bisOrderId: orderId, status: 'HELD' },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      // Sorted by product id → every transaction locks Product rows in the same order (no deadlocks, lesson 03/02 §7).
      for (const r of held
        .filter((r) => r.source === 'POSTGRES')
        .sort((a, b) => a.productId.localeCompare(b.productId))) {
        await this.sequelize.query(
          `UPDATE "Product" SET quantity = quantity + :q, version = version + 1 WHERE id = :id`,
          {
            replacements: { q: r.quantity, id: r.productId },
            transaction,
          },
        );
      }
      await this.reservationModel.update(
        { status: 'RELEASED' },
        { where: { bisOrderId: orderId, status: 'HELD' }, transaction },
      );

      const order = await this.orderModel.findByPk(orderId, {
        transaction,
        attributes: ['userId'],
      });
      await this.events.append(
        OrderCancelled.create(orderId, version, {
          userId: order!.userId,
          reason,
        }),
        transaction,
      );
      return { held, userId: order!.userId };
    });

    if (!released) return false;
    for (const r of released.held.filter((r) => r.source === 'FLASH')) {
      await this.flash
        .release(r.flashSaleId!, r.bucket!, r.quantity)
        .catch((e) => this.logger.warn(`flash release: ${e.message}`));
      await this.flash
        .releaseUserQuota(r.flashSaleId!, released.userId, r.quantity)
        .catch(() => undefined);
    }
    await this.notify(orderId, 'CANCELLED');
    return true;
  }

  async get(orderId: string, userId: string) {
    const order = await this.orderModel.findOne({
      where: { id: orderId, userId },
      include: ['items'],
    });
    if (!order) throw new NotFoundException('Order not found');
    const timeline = await this.sequelize.query(
      `SELECT "toStatus" AS status, reason, "createdAt" FROM "OrderEvent" WHERE "bisOrderId" = :orderId ORDER BY id`,
      {
        type: QueryTypes.SELECT,
        replacements: { orderId },
      },
    );
    return { ...order.get({ plain: true }), timeline };
  }

  private async notify(orderId: string, status: OrderStatus) {
    const order = await this.orderModel.findByPk(orderId, {
      attributes: ['userId'],
    });
    if (order)
      await this.realtime
        .publish(`user:${order.userId}`, 'order.status', { orderId, status })
        .catch(() => undefined);
  }
}
