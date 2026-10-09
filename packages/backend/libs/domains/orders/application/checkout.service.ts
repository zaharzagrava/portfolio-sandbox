import {
  Injectable,
  Optional,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/sequelize';
import { Op, QueryTypes, Sequelize, UniqueConstraintError } from 'sequelize';
import BisOrder from '../infra/models/bis-order.model';
import BisOrderItem from '../infra/models/bis-order-item.model';
import ShopOrder from '../infra/models/shop-order.model';
import StockReservation from '../infra/models/stock-reservation.model';
import { ProductModel as Product } from '@app/domains/catalog';
import { TransactionRunner } from '@app/infrastructure/context';
import { CheckoutDiscounts } from '../domain/checkout-discounts.port';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { CartRepository } from '../infra/cart.repository';
import { FlashStockService } from '../infra/flash-stock.service';
import { OrderService } from './order.service';
import { OrderReserved } from './events/order-events';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'orders.expire-reservation': { orderId: string };
  }
}

export const RESERVATION_HOLD_MS = 15 * 60_000;

export class Domain_OutOfStockError extends UnprocessableEntityException {
  constructor(readonly productId: string) {
    super({
      message: `Product ${productId} is out of stock`,
      productId,
      code: 'OUT_OF_STOCK',
    });
  }
}

interface PlannedLine {
  product: Pick<Product, 'id' | 'shopId' | 'price' | 'category'>;
  quantity: number;
  price: number;
  flash?: { saleId: string; bucket: number };
}

export interface CheckoutResult {
  orderId: string;
  status: string;
  total: number;
  currency: string;
  reservedUntil: Date | null;
  /** Pay with Idempotency-Key = orderId (README #3) so retries never double charge. */
  paymentIdempotencyKey: string;
}

/**
 * Checkout = reserve stock + create the order, atomically, then hand over to
 * payment (lesson 10/07 #19):
 *  - prices come from the database (or the flash sale), never from the client,
 *  - normal stock: conditional decrement `WHERE quantity >= q` (no read-then-write
 *    race), rows touched in product-id order (no deadlocks),
 *  - flash-sale stock: Redis buckets (no Postgres row lock on the hottest SKU),
 *    compensated if the database part fails,
 *  - idempotent per (user, Idempotency-Key): retries return the same order,
 *  - a 15-min hold, released by a scheduled job unless payment converts it.
 */
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    @InjectModel(BisOrder) private readonly orderModel: typeof BisOrder,
    @InjectModel(BisOrderItem) private readonly itemModel: typeof BisOrderItem,
    @InjectModel(ShopOrder) private readonly shopOrderModel: typeof ShopOrder,
    @InjectModel(StockReservation)
    private readonly reservationModel: typeof StockReservation,
    @InjectModel(Product) private readonly productModel: typeof Product,
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly tx: TransactionRunner,
    private readonly events: OutboxService,
    private readonly jobs: JobsService,
    private readonly carts: CartRepository,
    private readonly flash: FlashStockService,
    private readonly orders: OrderService,
    @Optional() private readonly discounts?: CheckoutDiscounts,
  ) {}

  async checkout(
    userId: string,
    cartId: string,
    idempotencyKey: string,
  ): Promise<CheckoutResult> {
    const existing = await this.orderModel.findOne({
      where: { userId, idempotencyKey },
    });
    if (existing) return this.result(existing);

    const lines = await this.carts.list(cartId);
    if (lines.length === 0)
      throw new UnprocessableEntityException('Cart is empty');

    const products = await this.productModel.findAll({
      where: { id: { [Op.in]: lines.map((l) => l.productId) } },
      attributes: ['id', 'shopId', 'price', 'category'],
      raw: true,
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    const flashSales = await this.flash.activeFor(
      lines.map((l) => l.productId),
    );

    const planned: PlannedLine[] = [];
    try {
      for (const line of lines) {
        const product = byId.get(line.productId);
        if (!product) throw new Domain_OutOfStockError(line.productId);
        const sale = flashSales.get(line.productId);

        if (sale) {
          if (
            !(await this.flash.claimUserQuota(
              sale.saleId,
              userId,
              line.quantity,
              sale.perUserLimit,
            ))
          ) {
            throw new UnprocessableEntityException(
              `Limit of ${sale.perUserLimit} per customer for this drop`,
            );
          }
          const bucket = await this.flash.reserve(
            sale.saleId,
            sale.buckets,
            line.quantity,
          );
          if (bucket === null) {
            await this.flash.releaseUserQuota(
              sale.saleId,
              userId,
              line.quantity,
            );
            throw new Domain_OutOfStockError(line.productId);
          }
          planned.push({
            product,
            quantity: line.quantity,
            price: sale.price,
            flash: { saleId: sale.saleId, bucket },
          });
        } else {
          planned.push({
            product,
            quantity: line.quantity,
            price: Number(product.price),
          });
        }
      }

      // SD-40: seller discount functions (sandboxed, time-boxed, fail-safe = catalogue price). Flash-sale lines keep their drop price.
      if (this.discounts) {
        const regular = planned.filter((l) => !l.flash);
        const prices = await this.discounts.unitPrices(
          regular.map((l) => ({
            productId: l.product.id,
            shopId: l.product.shopId,
            category: l.product.category ?? '',
            quantity: l.quantity,
            unitPrice: l.price,
          })),
        );
        regular.forEach(
          (l, i) => (l.price = Math.min(l.price, prices[i] ?? l.price)),
        );
      }

      const order = await this.createReservedOrder(
        userId,
        idempotencyKey,
        planned,
      );
      await this.carts
        .clear(cartId)
        .catch((e) => this.logger.warn(`cart clear failed: ${e.message}`));
      return this.result(order);
    } catch (error) {
      await this.compensateFlash(userId, planned);
      if (error instanceof UniqueConstraintError) {
        // Two concurrent requests with the same Idempotency-Key: the other one won.
        const winner = await this.orderModel.findOne({
          where: { userId, idempotencyKey },
        });
        if (winner) return this.result(winner);
      }
      throw error;
    }
  }

  private async createReservedOrder(
    userId: string,
    idempotencyKey: string,
    planned: PlannedLine[],
  ): Promise<BisOrder> {
    const reservedUntil = new Date(Date.now() + RESERVATION_HOLD_MS);
    const total = planned.reduce((sum, l) => sum + l.price * l.quantity, 0);

    return this.tx.run(
      async (transaction) => {
        const order = await this.orderModel.create(
          { userId, idempotencyKey, total, reservedUntil, status: 'PENDING' },
          { transaction },
        );

        const postgresLines = planned
          .filter((l) => !l.flash)
          .sort((a, b) => a.product.id.localeCompare(b.product.id));
        for (const line of postgresLines) {
          const [rows] = await this.sequelize.query(
            `UPDATE "Product" SET quantity = quantity - :q, version = version + 1 WHERE id = :id AND quantity >= :q RETURNING id`,
            {
              replacements: { q: line.quantity, id: line.product.id },
              transaction,
            },
          );
          if (rows.length === 0)
            throw new Domain_OutOfStockError(line.product.id);
        }

        await this.itemModel.bulkCreate(
          planned.map((l) => ({
            bisOrderId: order.id,
            productId: l.product.id,
            quantity: l.quantity,
            priceAtPurchase: l.price,
            shopId: l.product.shopId,
            flashSaleId: l.flash?.saleId ?? null,
          })),
          { transaction },
        );

        await this.reservationModel.bulkCreate(
          planned.map((l) => ({
            bisOrderId: order.id,
            productId: l.product.id,
            quantity: l.quantity,
            source: l.flash ? ('FLASH' as const) : ('POSTGRES' as const),
            flashSaleId: l.flash?.saleId ?? null,
            bucket: l.flash?.bucket ?? null,
            expiresAt: reservedUntil,
          })),
          { transaction },
        );

        const subtotals = new Map<string | null, number>();
        for (const l of planned)
          subtotals.set(
            l.product.shopId,
            (subtotals.get(l.product.shopId) ?? 0) + l.price * l.quantity,
          );
        await this.shopOrderModel.bulkCreate(
          [...subtotals.entries()].map(([shopId, subtotal]) => ({
            bisOrderId: order.id,
            shopId,
            subtotal,
          })),
          { transaction },
        );

        const version = (await this.orders.transition(
          order.id,
          { type: 'reserve' },
          null,
          transaction,
        ))!;
        await this.events.append(
          OrderReserved.create(order.id, version, {
            userId,
            total,
            currency: order.currency ?? 'EUR',
            shopIds: [...subtotals.keys()],
            reservedUntil: reservedUntil.toISOString(),
          }),
          transaction,
        );
        // Transactional enqueue (SD-29): the expiry job exists iff the order does.
        await this.jobs.enqueue(
          'orders.expire-reservation',
          { orderId: order.id },
          { runAt: reservedUntil, idempotencyKey: `order-expire:${order.id}` },
        );

        order.status = 'RESERVED';
        return order;
      },
      { lockTimeoutMs: 2_000 },
    );
  }

  private async compensateFlash(userId: string, planned: PlannedLine[]) {
    for (const l of planned.filter((l) => l.flash)) {
      await this.flash
        .release(l.flash!.saleId, l.flash!.bucket, l.quantity)
        .catch(() => undefined);
      await this.flash
        .releaseUserQuota(l.flash!.saleId, userId, l.quantity)
        .catch(() => undefined);
    }
  }

  private result(order: BisOrder): CheckoutResult {
    return {
      orderId: order.id,
      status: order.status,
      total: Number(order.total),
      currency: order.currency ?? 'EUR',
      reservedUntil: order.reservedUntil,
      paymentIdempotencyKey: order.id,
    };
  }

  /** Used by the history endpoint (covering index on userId, createdAt INCLUDE status, total). */
  async history(userId: string, before?: string, limit = 20) {
    return this.sequelize.query(
      `SELECT id, status, total, "createdAt" FROM "BisOrder"
       WHERE "userId" = :userId ${before ? `AND "createdAt" < :before` : ''}
       ORDER BY "createdAt" DESC LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { userId, before, limit } },
    );
  }
}
