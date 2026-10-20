import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
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
  ATTRIBUTION_RESOLVER,
  CART_STORE,
  CHECKOUT_LOCK,
  ORDER_REPOSITORY,
  PRODUCT_CATALOG,
  SHOP_DIRECTORY,
  SHOP_DISCOUNTS,
  type AttributionResolverPort,
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
import { withTimeout } from '../domain/with-timeout';
import {
  FLASH_CRASH_POINT,
  FLASH_RESERVATION,
  SimulatedCrash,
  type CrashPoint,
  type FlashHold,
  type FlashReservationPort,
  type OpenSale,
} from '../domain/flash-ports';
import { FlashSaleLimitExceededError } from '../domain/flash-errors';
import { OrderLifecycleService } from './order-lifecycle.service';
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
    @Optional()
    @Inject(ATTRIBUTION_RESOLVER)
    private readonly attribution: AttributionResolverPort | null,
    @Inject(FLASH_RESERVATION) private readonly flash: FlashReservationPort,
    @Inject(FLASH_CRASH_POINT) private readonly crash: CrashPoint,
    private readonly reservation: OrderReservationService,
    private readonly lifecycle: OrderLifecycleService,
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
    // While a drop is open the early lookup is skipped: a refused drop attempt must cost no relational statement
    // (S11 AS-06). A replay then meets its order at the write below (`ON CONFLICT DO NOTHING` → the winner).
    if (!(await this.dropOpen())) {
      const existing = await this.orders.findByKey(userId, idempotencyKey);
      if (existing) return this.resolveExisting(existing, requestHash);
    }

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

  /** Any drop open right now? A failing directory counts as "no": the regular path is the safe default. */
  private async dropOpen(): Promise<boolean> {
    try {
      return await this.flash.anyOpen(this.clock.now());
    } catch {
      return false;
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
    let categories: Map<string, string>;
    let currency: string;
    // Drop lines (S11): their units are claimed in the fast store before the order exists (BEFORE_ORDER).
    let holds: FlashHold[] = [];
    let claimedAtMs = 0;
    const flashByProduct = new Map<
      string,
      { flashSaleId: string; claimId: string }
    >();
    try {
      const lines = await within(() => this.cart.list(cartId, now));
      if (lines.length === 0) throw new CartEmptyError();
      consumed = lines.map((l) => ({
        productId: l.productId,
        quantity: l.quantity,
      }));

      // Sales open now come from the cached directory (no Redis, no relational statement). Admission is the first
      // thing a drop attempt pays for: before the catalog and shop reads, which only admitted buyers cost.
      const sales = await within(() =>
        this.flash.openSales(
          lines.map((l) => l.productId),
          now,
        ),
      );
      if (sales.size > 0)
        await within(() => this.flash.admit(userId, [...sales.values()]));

      // All-or-nothing across the drop lines, right after admission: a sold-out drop is refused with a few fast-store
      // round trips and no relational statement, and creates no order. The refusal leaves the idempotency key unused.
      const dropLines = lines.filter((l) => sales.has(l.productId));
      if (dropLines.length > 0) {
        const reserved = await within(() =>
          this.flash.reserve(
            userId,
            idempotencyKey,
            dropLines.map((l) => ({
              sale: sales.get(l.productId) as OpenSale,
              productId: l.productId,
              quantity: l.quantity,
            })),
          ),
        );
        if (reserved.kind === 'rejected')
          throw reserved.code === 'out_of_stock'
            ? new OutOfStockError([reserved.productId], reserved.flashSaleId)
            : new FlashSaleLimitExceededError(
                reserved.limit as number,
                reserved.flashSaleId,
              );
        claimedAtMs = this.clock.nowMs();
        holds = reserved.holds.map((h) => ({
          saleId: h.flashSaleId,
          claimId: h.sourceRef,
          productId: h.productId,
          quantity: h.quantity,
          unitPriceMinor: h.unitPriceMinor,
        }));
        for (const h of reserved.holds)
          flashByProduct.set(h.productId, {
            flashSaleId: h.flashSaleId,
            claimId: h.sourceRef,
          });
      }

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
      categories = new Map([...products].map(([id, p]) => [id, p.category]));

      const dropPrice = new Map(
        holds.map((h) => [h.productId, h.unitPriceMinor]),
      );

      const priceLines = lines.map((l) => {
        const p = products.get(l.productId) as CatalogProduct;
        const drop = dropPrice.get(l.productId);
        return {
          productId: l.productId,
          shopId: p.shopId as string,
          // The drop price is final: no catalogue price, no discount.
          unitPriceMinor: drop ?? p.priceMinor,
          quantity: l.quantity,
          category: p.category,
          noDiscount: drop !== undefined,
        };
      });
      const shopDiscounts = await this.shopDiscounts(
        priceLines.filter((l) => !l.noDiscount),
        currency,
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
      await this.giveBackHolds(holds, error);
      throw this.preOrderFailure(error);
    }

    // Tx 1: the order, its snapshots, its shop orders and its reservation requests, atomically.
    const orderId = uuidv7();
    const credited = await this.attribute(userId, request.ref);
    let created: OrderRecord | null;
    try {
      await this.crash.hit('checkout:before-order-write');
      // Too little of the claim window left to write the order safely: give the units back (S11 FR-025).
      if (
        holds.length > 0 &&
        this.clock.nowMs() - claimedAtMs >
          (this.config.get('orders_flash_claim_window_seconds') -
            this.config.get('orders_flash_order_margin_seconds')) *
            1000
      ) {
        checkoutCounter.add(1, { outcome: 'unavailable' satisfies Outcome });
        throw new CheckoutUnavailableError();
      }
      created = await this.runner.run(() =>
        this.orders.createPending({
          id: orderId,
          userId,
          idempotencyKey,
          requestHash,
          refCode: credited?.code ?? null,
          attributionOwnerId: credited?.ownerId ?? null,
          totalMinor: priced.totalMinor,
          currency,
          now,
          flashExpiresAt: new Date(
            now.getTime() + this.config.get('orders_hold_seconds') * 1000,
          ),
          items: priced.lines.map((l) => ({
            productId: l.productId,
            shopId: l.shopId,
            title: titles.get(l.productId) ?? '',
            category: categories.get(l.productId) ?? null,
            quantity: l.quantity,
            unitPriceMinor: l.unitPriceMinor,
            discountMinor: l.discountMinor,
            lineTotalMinor: l.lineTotalMinor,
            flash: flashByProduct.get(l.productId),
          })),
          shopOrders: priced.shops,
        }),
      );
    } catch (error) {
      await this.giveBackHolds(holds, error);
      throw error;
    }
    if (!created) {
      // another request with this key wrote its order between our check and our insert; the claims are its too
      const winner = await this.orders.findByKey(userId, idempotencyKey);
      if (winner) return this.resolveExisting(winner, requestHash);
      throw new CheckoutUnavailableError();
    }

    // The order exists and holds the drop rows: the claims are committed (the sweeper does it if this call is lost).
    if (holds.length > 0) {
      await this.crash.hit('checkout:after-order-write');
      await this.commitHolds(orderId, holds);
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
    this.logger.log(`order ${orderId}: checkout reserved`);
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

  /**
   * Who is credited for this order (J05): the owner of the `ref` link, resolved once and frozen on the order. An unknown,
   * disabled or own link credits no one, and a lookup that fails neither: a reference never costs a sale.
   */
  private async attribute(
    userId: string,
    ref: string | undefined,
  ): Promise<{ code: string; ownerId: string } | null> {
    if (!ref || !this.attribution) return null;
    try {
      const link = await withTimeout(
        this.attribution.resolve(ref),
        this.config.get('orders_catalog_timeout_ms'),
        () => new Error('attribution lookup timed out'),
      );
      if (!link || link.status === 'DISABLED' || link.ownerId === userId)
        return null;
      return { code: link.code, ownerId: link.ownerId };
    } catch (error) {
      this.logger.warn(
        `attribution lookup failed, order not credited: ${error instanceof Error ? error.name : 'error'}`,
      );
      return null;
    }
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
    const fingerprint: Record<string, unknown> = {};
    if (request.expectedTotalMinor !== undefined)
      fingerprint.expectedTotalMinor = request.expectedTotalMinor;
    if (request.ref !== undefined) fingerprint.ref = request.ref;
    const canonical = JSON.stringify(fingerprint);
    return createHash('sha256').update(canonical).digest('hex');
  }

  /** A checkout that fails before its order exists returns the drop units it claimed (a dead process would not). */
  private async giveBackHolds(
    holds: FlashHold[],
    error: unknown,
  ): Promise<void> {
    if (holds.length === 0 || error instanceof SimulatedCrash) return;
    await this.flash.release(holds);
  }

  /**
   * `COMMITTED` after the order write. A claim that is no longer held (the sweeper gave it back first) means the units
   * are gone: the order is cancelled and the buyer retries. A failed call is only logged: the claim stays in the
   * sweeper's set, which finds the durable row and commits it.
   */
  private async commitHolds(
    orderId: string,
    holds: FlashHold[],
  ): Promise<void> {
    let held: boolean;
    try {
      held = await this.flash.commit(holds);
    } catch (error) {
      this.logger.warn(
        `order ${orderId}: commit of drop claims failed (${(error as Error).name}); the sweeper commits them`,
      );
      return;
    }
    if (held) return;
    await this.lifecycle.transition(
      orderId,
      { type: 'cancel', reason: 'out_of_stock' },
      { actor: 'system:checkout' },
    );
    checkoutCounter.add(1, { outcome: 'unavailable' satisfies Outcome });
    throw new CheckoutUnavailableError();
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
    currency: string,
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
        this.discounts.evaluate(lines, currency),
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
