import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type {
  CheckoutRequest,
  CheckoutResponse,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { AppError } from '@app/common/errors';
import { TransactionRunner } from '@app/infrastructure/context';
import { idempotencyError } from '@app/infrastructure/idempotency/idempotency.errors';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import {
  CART_STORE,
  CHECKOUT_LOCK,
  ORDER_REPOSITORY,
  PRODUCT_CATALOG,
  SHOP_DIRECTORY,
  SHOP_DISCOUNTS,
  type CartStore,
  type CatalogProduct,
  type CheckoutLock,
  type DiscountLine,
  type OrderRecord,
  type OrderRepository,
  type ProductCatalogPort,
  type ShopDirectoryPort,
  type ShopDiscountsPort,
} from '../domain/ports';
import {
  CartEmptyError,
  CheckoutInProgressError,
  CheckoutUnavailableError,
  MixedCurrencyError,
  OutOfStockError,
  PriceChangedError,
  ProductUnavailableError,
  UpstreamUnavailableError,
} from '../domain/order-errors';
import {
  checkoutCounter,
  discountFallbackCounter,
} from '../domain/order-metrics';
import { priceCart, type PricedCart } from '../domain/money-allocation';
import { userCartId } from '../domain/guest-cart-token';
import { withTimeout } from '../infra/with-timeout';
import { OrderReservationService } from './order-reservation.service';

import './order.job-types';

type Outcome =
  | 'reserved'
  | 'out_of_stock'
  | 'price_changed'
  | 'invalid'
  | 'unavailable'
  | 'in_progress'
  | 'replayed';

/**
 * Checkout (S10 US2, US3): price the cart on the server, write the order `PENDING`, take the stock through the
 * catalog, move the order to `RESERVED` (D-4). No transaction spans two capabilities and none contains a network
 * call: the catalog read, the shop read, the discount source, the stock command, the lock and the cart store all run
 * outside the two short transactions. The order row also guards the idempotency key after the interceptor's record
 * expires and while a checkout whose stock answer was lost waits for recovery (D-3).
 */
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(CART_STORE) private readonly cart: CartStore,
    @Inject(CHECKOUT_LOCK) private readonly lock: CheckoutLock,
    @Inject(PRODUCT_CATALOG) private readonly catalog: ProductCatalogPort,
    @Inject(SHOP_DIRECTORY) private readonly shops: ShopDirectoryPort,
    @Inject(SHOP_DISCOUNTS) private readonly discounts: ShopDiscountsPort,
    private readonly reservation: OrderReservationService,
    private readonly runner: TransactionRunner,
    private readonly jobs: JobsService,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async checkout(
    userId: string,
    idempotencyKey: string,
    request: CheckoutRequest,
  ): Promise<CheckoutResponse> {
    const requestHash = this.hashOf(request);
    const existing = await this.orders.findByKey(userId, idempotencyKey);
    if (existing) return this.resolveExisting(existing, requestHash);

    const token = await this.lock.acquire(userId);
    if (!token) {
      checkoutCounter.add(1, { outcome: 'in_progress' satisfies Outcome });
      throw new CheckoutInProgressError();
    }
    try {
      return await this.run(userId, idempotencyKey, request, requestHash);
    } finally {
      await this.lock.release(userId, token);
    }
  }

  private async run(
    userId: string,
    idempotencyKey: string,
    request: CheckoutRequest,
    requestHash: string,
  ): Promise<CheckoutResponse> {
    const started = process.hrtime.bigint();
    const budgetMs = this.config.get('orders_checkout_budget_ms');
    const within = <T>(call: () => Promise<T>): Promise<T> => {
      const remaining =
        budgetMs - Number(process.hrtime.bigint() - started) / 1e6;
      if (remaining <= 0) throw new CheckoutUnavailableError();
      return withTimeout(
        call(),
        remaining,
        () => new CheckoutUnavailableError(),
      );
    };

    const cartId = userCartId(userId);
    const now = this.clock.now();
    let priced: PricedCart;
    let consumed: Array<{ productId: string; quantity: number }>;
    let titles: Map<string, string>;
    let currency: string;
    try {
      const lines = await within(() => this.cart.list(cartId, now));
      if (lines.length === 0) throw new CartEmptyError();
      consumed = lines.map((l) => ({
        productId: l.productId,
        quantity: l.quantity,
      }));

      const products = await within(() =>
        this.catalog.getProducts(lines.map((l) => l.productId)),
      );
      const shopIds = [
        ...new Set(
          [...products.values()]
            .map((p) => p.shopId)
            .filter((s): s is string => !!s),
        ),
      ];
      const shops = await within(() => this.shops.getShops(shopIds));

      const bad = lines
        .filter((l) => {
          const p = products.get(l.productId);
          const shop = p?.shopId ? shops.get(p.shopId) : undefined;
          return (
            !p ||
            p.status !== 'ACTIVE' ||
            p.isSandbox ||
            !p.shopId ||
            !shop ||
            shop.status !== 'ACTIVE' ||
            shop.isSandbox
          );
        })
        .map((l) => l.productId);
      if (bad.length > 0) throw new ProductUnavailableError(bad);

      const currencies = new Set([...products.values()].map((p) => p.currency));
      if (currencies.size > 1) throw new MixedCurrencyError();
      currency = [...currencies][0];
      titles = new Map([...products].map(([id, p]) => [id, p.title]));

      const priceLines = lines.map((l) => {
        const p = products.get(l.productId) as CatalogProduct;
        return {
          productId: l.productId,
          shopId: p.shopId as string,
          unitPriceMinor: p.priceMinor,
          quantity: l.quantity,
          category: p.category,
        };
      });
      const shopDiscounts = await this.shopDiscounts(
        priceLines,
        started,
        budgetMs,
      );
      priced = priceCart({ lines: priceLines, shopDiscounts });

      if (
        request.expectedTotalMinor !== undefined &&
        request.expectedTotalMinor !== priced.totalMinor
      )
        throw new PriceChangedError(
          priced.totalMinor,
          priced.lines.map((l) => ({
            productId: l.productId,
            unitPriceMinor: l.unitPriceMinor,
          })),
        );
    } catch (error) {
      throw this.preOrderFailure(error);
    }

    // Tx 1: the order, its snapshots, its shop orders and its reservation requests, atomically.
    const orderId = uuidv7();
    const created = await this.runner.run(() =>
      this.orders.createPending({
        id: orderId,
        userId,
        idempotencyKey,
        requestHash,
        totalMinor: priced.totalMinor,
        currency,
        now,
        items: priced.lines.map((l) => ({
          productId: l.productId,
          shopId: l.shopId,
          title: titles.get(l.productId) ?? '',
          quantity: l.quantity,
          unitPriceMinor: l.unitPriceMinor,
          discountMinor: l.discountMinor,
          lineTotalMinor: l.lineTotalMinor,
        })),
        shopOrders: priced.shops,
      }),
    );
    if (!created) {
      // another request with this key wrote its order between our check and our insert
      const winner = await this.orders.findByKey(userId, idempotencyKey);
      if (winner) return this.resolveExisting(winner, requestHash);
      throw new CheckoutUnavailableError();
    }

    // The stock step; an unknown outcome leaves the order PENDING for the recovery job.
    let outcome;
    try {
      outcome = await this.reservation.reserve(orderId, `user:${userId}`);
    } catch (error) {
      this.logger.warn(
        `order ${orderId}: stock outcome unknown (${(error as Error).name}); left PENDING`,
      );
      checkoutCounter.add(1, { outcome: 'unavailable' satisfies Outcome });
      throw new CheckoutUnavailableError();
    }
    if (outcome.kind === 'rejected') {
      checkoutCounter.add(1, { outcome: 'out_of_stock' satisfies Outcome });
      if (outcome.insufficient.length === 0) {
        const error = new ProductUnavailableError(outcome.unavailable);
        error.idempotencyFinal = true;
        throw error;
      }
      throw new OutOfStockError([
        ...new Set([...outcome.insufficient, ...outcome.unavailable]),
      ]);
    }
    if (outcome.kind === 'gone') {
      checkoutCounter.add(1, { outcome: 'unavailable' satisfies Outcome });
      throw new CheckoutUnavailableError();
    }

    await this.consumeCart(cartId, consumed, orderId, now);
    checkoutCounter.add(1, { outcome: 'reserved' satisfies Outcome });
    return this.answer(outcome.order);
  }

  /** The order already holds this key: a different body is a misuse; a pending order is in flight; the rest are the answer. */
  private async resolveExisting(
    order: OrderRecord,
    requestHash: string,
  ): Promise<CheckoutResponse> {
    if (order.requestHash !== null && order.requestHash !== requestHash)
      throw idempotencyError('idempotency_key_reuse');
    checkoutCounter.add(1, { outcome: 'replayed' satisfies Outcome });
    if (order.status === 'PENDING')
      throw idempotencyError('idempotency_in_flight', { retryAfterSeconds: 1 });
    if (order.status === 'CANCELLED' && order.cancelReason === 'out_of_stock') {
      const items = await this.orders.items(order.id);
      throw new OutOfStockError(items.map((i) => i.productId));
    }
    return this.answer(order);
  }

  private answer(order: OrderRecord): CheckoutResponse {
    return {
      orderId: order.id,
      status: 'RESERVED',
      totalMinor: order.totalMinor,
      currency: order.currency,
      reservedUntil: (order.reservedUntil ?? order.createdAt).toISOString(),
    };
  }

  private hashOf(request: CheckoutRequest): string {
    const canonical =
      request.expectedTotalMinor === undefined
        ? '{}'
        : JSON.stringify({ expectedTotalMinor: request.expectedTotalMinor });
    return createHash('sha256').update(canonical).digest('hex');
  }

  /** Failures before an order exists: the domain's own problems pass through, a collaborator's silence is a 503. */
  private preOrderFailure(error: unknown): unknown {
    if (error instanceof UpstreamUnavailableError) {
      checkoutCounter.add(1, { outcome: 'unavailable' satisfies Outcome });
      return new CheckoutUnavailableError();
    }
    if (error instanceof AppError) {
      const outcome: Outcome =
        error instanceof PriceChangedError
          ? 'price_changed'
          : error instanceof CheckoutUnavailableError
            ? 'unavailable'
            : 'invalid';
      checkoutCounter.add(1, { outcome });
    }
    return error;
  }

  /**
   * Seller discounts per shop, validated; any failure falls back to catalogue prices (for the affected shop when the
   * answer is partly wrong, for all on a timeout or error) and is counted; the warning carries no discount payload.
   */
  private async shopDiscounts(
    lines: Array<DiscountLine & { productId: string }>,
    started: bigint,
    budgetMs: number,
  ): Promise<Array<{ shopId: string; discountMinor: number }>> {
    const gross = new Map<string, number>();
    for (const l of lines)
      gross.set(
        l.shopId,
        (gross.get(l.shopId) ?? 0) + l.unitPriceMinor * l.quantity,
      );
    const remaining =
      budgetMs - Number(process.hrtime.bigint() - started) / 1e6;
    if (remaining <= 0) throw new CheckoutUnavailableError();

    let raw: unknown;
    try {
      raw = await withTimeout(
        this.discounts.evaluate(lines),
        Math.min(this.config.get('orders_discount_timeout_ms'), remaining),
        () => new UpstreamUnavailableError('discounts'),
      );
    } catch (error) {
      const reason =
        error instanceof UpstreamUnavailableError ? 'timeout' : 'error';
      discountFallbackCounter.add(1, { reason });
      this.logger.warn(
        `discount source failed (${reason}); catalogue prices used`,
      );
      return [];
    }
    if (!Array.isArray(raw)) {
      discountFallbackCounter.add(1, { reason: 'invalid' });
      this.logger.warn(
        'discount source answered an invalid result; catalogue prices used',
      );
      return [];
    }
    const valid: Array<{ shopId: string; discountMinor: number }> = [];
    for (const entry of raw as Array<{
      shopId?: unknown;
      discountMinor?: unknown;
    }>) {
      const shopGross =
        typeof entry?.shopId === 'string' ? gross.get(entry.shopId) : undefined;
      if (
        shopGross === undefined ||
        typeof entry.discountMinor !== 'number' ||
        !Number.isSafeInteger(entry.discountMinor) ||
        entry.discountMinor < 0 ||
        entry.discountMinor > shopGross
      ) {
        discountFallbackCounter.add(1, { reason: 'invalid' });
        this.logger.warn(
          'discount source answered an invalid amount; catalogue prices used for that shop',
        );
        continue;
      }
      valid.push({
        shopId: entry.shopId as string,
        discountMinor: entry.discountMinor,
      });
    }
    return valid;
  }

  /** Removes exactly what the order took; a refusal is logged and handed to a retrying job, never fatal. */
  private async consumeCart(
    cartId: string,
    consumed: Array<{ productId: string; quantity: number }>,
    orderId: string,
    now: Date,
  ): Promise<void> {
    try {
      await this.cart.removeConsumed(cartId, consumed, now);
    } catch (error) {
      this.logger.warn(
        `order ${orderId}: cart clean-up failed (${(error as Error).name}); a job will retry`,
      );
      try {
        await this.jobs.enqueue(
          'orders.clear-cart',
          { cartId, consumed },
          { idempotencyKey: `clear-cart:${orderId}` },
        );
      } catch (enqueueError) {
        this.logger.error(
          `order ${orderId}: clear-cart job not queued (${(enqueueError as Error).name})`,
        );
      }
    }
  }
}
