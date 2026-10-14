import { Inject, Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { createHash } from 'node:crypto';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { UserDirectoryService } from '@app/domains/identity';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  ORDER_REPOSITORY,
  SHOP_DIRECTORY,
  type OrderRecord,
  type OrderRepository,
  type ShopDirectoryPort,
} from '../domain/ports';
import {
  fixedPriceOrderCommandSchema,
  isValidUnitPrice,
  OrderCommandRejectedError,
  type FixedPriceOrderAnswer,
  type FixedPriceOrderCommand,
} from '../domain/order-command';
import { OrderLifecycleService } from './order-lifecycle.service';

export type { FixedPriceOrderAnswer, FixedPriceOrderCommand };

/**
 * The commands other capabilities send to `orders` (IX.7 R1). `createFixedPriceOrder` (S21 R-04) writes a `RESERVED`
 * order for one unit another capability already holds: priced by the caller, no discount, no catalog stock command.
 * Its reservation row is `EXTERNAL`, so a cancel or an expiry emits `order.cancelled` but returns no stock.
 *
 * Idempotent by the order's own `(userId, idempotencyKey)`: a second call with the key answers the stored order with
 * `replayed: true`, whatever state it has reached since. The only two rejections that are permanent are the typed
 * `OrderCommandRejectedError`s; anything else thrown is transient and safe to retry.
 */
@Injectable()
export class OrderCommandService {
  private readonly logger = new Logger(OrderCommandService.name);

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(SHOP_DIRECTORY) private readonly shops: ShopDirectoryPort,
    private readonly users: UserDirectoryService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly runner: TransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async createFixedPriceOrder(
    input: FixedPriceOrderCommand,
  ): Promise<FixedPriceOrderAnswer> {
    if (
      typeof input?.unitPriceMinor !== 'number' ||
      !isValidUnitPrice(input.unitPriceMinor)
    )
      throw new OrderCommandRejectedError('invalid_price');
    const cmd = fixedPriceOrderCommandSchema.parse(input);

    const existing = await this.orders.findByKey(
      cmd.buyerId,
      cmd.idempotencyKey,
    );
    if (existing) return this.answer(existing, true);

    // Reads of other capabilities run outside the transaction.
    const buyers = await this.users.getUsersByIds([cmd.buyerId]);
    if (!buyers.has(cmd.buyerId))
      throw new OrderCommandRejectedError('buyer_not_eligible');
    const shop = (await this.shops.getShops([cmd.shopId])).get(cmd.shopId);
    if (!shop || shop.status !== 'ACTIVE' || shop.isSandbox)
      throw new OrderCommandRejectedError('shop_not_eligible');

    const reservedUntil = new Date(cmd.reservedUntil);
    const actor = `system:${cmd.origin.kind.toLowerCase()}`;
    const created = await this.runner.run(async () => {
      const order = await this.orders.createPending({
        id: uuidv7(),
        userId: cmd.buyerId,
        idempotencyKey: cmd.idempotencyKey,
        requestHash: createHash('sha256')
          .update(JSON.stringify([cmd.productId, cmd.unitPriceMinor]))
          .digest('hex'),
        refCode: null,
        totalMinor: cmd.unitPriceMinor,
        currency: cmd.currency,
        now: this.clock.now(),
        flashExpiresAt: reservedUntil,
        items: [
          {
            productId: cmd.productId,
            shopId: cmd.shopId,
            title: cmd.titleSnapshot,
            quantity: cmd.quantity,
            unitPriceMinor: cmd.unitPriceMinor,
            discountMinor: 0,
            lineTotalMinor: cmd.unitPriceMinor,
            external: { ref: cmd.origin.ref },
          },
        ],
        shopOrders: [{ shopId: cmd.shopId, subtotalMinor: cmd.unitPriceMinor }],
      });
      if (!order) return null;
      const moved = await this.lifecycle.applyInTransaction(
        order.id,
        { type: 'reserve' },
        { actor, reservedUntil },
      );
      if (moved.kind !== 'applied')
        throw new Error(`order ${order.id} could not be reserved`);
      return moved.order;
    });
    if (created) {
      this.logger.log(
        `order ${created.id}: ${cmd.origin.kind} ${cmd.origin.step} order reserved`,
      );
      return this.answer(created, false);
    }

    // another call with this key committed between our read and our insert
    const winner = await this.orders.findByKey(cmd.buyerId, cmd.idempotencyKey);
    if (!winner) throw new Error('order key conflict without a stored order');
    return this.answer(winner, true);
  }

  private answer(order: OrderRecord, replayed: boolean): FixedPriceOrderAnswer {
    return {
      orderId: order.id,
      status: 'RESERVED',
      reservedUntil: (order.reservedUntil ?? order.createdAt).toISOString(),
      replayed,
    };
  }
}
