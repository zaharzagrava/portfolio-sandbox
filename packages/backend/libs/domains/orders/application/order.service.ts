import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/sequelize';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import BisOrder from '../infra/models/bis-order.model';
import {
  OrderCommand,
  OrderStatus,
  transitionFor,
} from '../domain/order-state';

/**
 * TRANSITIONAL (research D-1): the one guarded move that the auctions worker still calls to put the order it creates
 * into `RESERVED`. It is not used by anything in this domain: checkout, payment, expiry and cancel go through
 * `OrderLifecycleService`. Deleted when S21 replaces the auctions' direct order creation with an order-creating command.
 */
@Injectable()
export class OrderService {
  constructor(
    @InjectModel(BisOrder) private readonly orderModel: typeof BisOrder,
    @InjectConnection() private readonly sequelize: Sequelize,
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
      `INSERT INTO "OrderEvent" ("bisOrderId", "fromStatus", "toStatus", "reason", "actor") VALUES (:orderId, :from, :to, :reason, 'system:legacy')`,
      {
        replacements: { orderId, from: rows[0].previous, to, reason },
        transaction,
      },
    );
    return rows[0].version;
  }
}
