import { randomUUID } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { ProductQueryService } from '@app/domains/catalog';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import {
  createCatalogApp,
  type CatalogTestApp,
} from '@app/test/utils/catalog-app';
import {
  createProduct,
  type ProductSeed,
  type SeededProduct,
} from '@app/test/utils/catalog-fixtures';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import { OrdersModule } from '../orders.module';
import { OrdersJobsModule } from '../orders-worker.module';
import { OrdersCoreModule } from '../orders-core.module';
import { PaymentsEventsConsumer } from '../infra/payments-events.consumer';
import {
  ORDER_REPOSITORY,
  PAYMENT_STATUS,
  SHOP_DISCOUNTS,
  type DiscountLine,
  type OrderRecord,
  type OrderRepository,
  type PaymentStatus,
  type PaymentStatusPort,
  type ShopDiscountsPort,
} from '../domain/ports';
import { PaymentStatusUnavailableError } from '../domain/order-errors';

/** The payments consumer without the Kafka framework: specs call `project` directly (as the other domains' consumer specs do). */
@Module({
  imports: [OrdersCoreModule],
  providers: [PaymentsEventsConsumer],
  exports: [PaymentsEventsConsumer],
})
class PaymentsConsumerProbeModule {}

/** The secrets the kit boots the app with; specs sign webhook events and cookies with them. */
export const KIT_CART_COOKIE_SECRET =
  'orders-kit-cart-cookie-secret-0123456789abcdef';
export const KIT_WEBHOOK_SECRET = 'whsec_orders_kit_current_secret';
export const KIT_WEBHOOK_SECRET_PREVIOUS = 'whsec_orders_kit_previous_secret';

/** The payments capability's `getPaymentStatus` (S13 is not built): a contract-valid fake with a switch for outages. */
export class FakePaymentStatus implements PaymentStatusPort {
  readonly statuses = new Map<string, PaymentStatus>();
  readonly calls: string[] = [];
  /** Number of upcoming calls that fail as "payments unavailable". */
  failNext = 0;

  getPaymentStatus(paymentRef: string): Promise<PaymentStatus> {
    this.calls.push(paymentRef);
    if (this.failNext > 0) {
      this.failNext -= 1;
      return Promise.reject(new PaymentStatusUnavailableError());
    }
    const found = this.statuses.get(paymentRef);
    return found
      ? Promise.resolve(found)
      : Promise.resolve({ status: 'UNKNOWN', amountMinor: 0, currency: 'USD' });
  }

  reset(): void {
    this.statuses.clear();
    this.calls.length = 0;
    this.failNext = 0;
  }
}

/** The seller-discount source (S45): returns what a spec programs; absent by default (no discounts). */
export class FakeDiscounts implements ShopDiscountsPort {
  impl: ((lines: DiscountLine[]) => Promise<unknown>) | null = null;

  async evaluate(lines: DiscountLine[]) {
    if (!this.impl) return [];
    return (await this.impl(lines)) as Array<{
      shopId: string;
      discountMinor: number;
    }>;
  }

  reset(): void {
    this.impl = null;
  }
}

/** The realtime hub's transport: records publishes, or refuses them while `down`. */
export class FakeRealtimePublisher {
  readonly published: Array<{ topic: string; type: string; data: unknown }> =
    [];
  down = false;

  publish(topic: string, type: string, data: unknown): Promise<string> {
    if (this.down) return Promise.reject(new Error('realtime hub is down'));
    this.published.push({ topic, type, data });
    return Promise.resolve('0-0');
  }

  reset(): void {
    this.published.length = 0;
    this.down = false;
  }
}

/** A latch: callers of `wait()` block until `open()`; `reached` resolves when the first caller arrives. */
export function createGate() {
  let release!: () => void;
  let reach!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (reach = resolve));
  return {
    reached,
    open: () => release(),
    async wait() {
      reach();
      await opened;
    },
  };
}

type AnyFn = (...args: never[]) => unknown;

export interface OrdersTestApp extends CatalogTestApp {
  payments: FakePaymentStatus;
  discounts: FakeDiscounts;
  realtime: FakeRealtimePublisher;
  /**
   * Replaces `target[method]` with `wrapper(original)` until `reset()` or the returned `restore()`: the fault gates of
   * the plan (a latch inside the stock call, a refused cart write, a delayed catalog read) are installed this way on
   * the real adapters.
   */
  patch<T extends object, K extends keyof T>(
    target: T,
    method: K,
    wrapper: (original: T[K] extends AnyFn ? T[K] : never) => T[K],
  ): () => void;
}

/**
 * The real app the orders specs run against: `OrdersModule` (HTTP) and `OrdersWorkerModule` (job handlers, called
 * directly by the specs) next to the catalog and identity APIs, over real Postgres, Redis and DynamoDB Local, with the
 * production prefix, pipe, filter and the S50 limiter (`generateTestingModule` installs `RateLimitModule.forRoot()`, so
 * a `429` is real). Faked only at the system edges: the payments status service, the discount source, the realtime
 * transport and the clock (S10 test-plan.md).
 */
export async function createOrdersApp(
  options: {
    extraImports?: unknown[];
    overrides?: Array<{ provide: unknown; useValue: unknown }>;
    env?: Record<string, string>;
    /** Address of a fault proxy in front of Redis (rate limiter, checkout lock), read once when the app boots. */
    redisUrl?: string;
  } = {},
): Promise<OrdersTestApp> {
  const payments = new FakePaymentStatus();
  const discounts = new FakeDiscounts();
  const realtime = new FakeRealtimePublisher();
  const base = await createCatalogApp({
    redisUrl: options.redisUrl,
    extraImports: [
      JobsModule,
      OrdersModule,
      OrdersJobsModule,
      PaymentsConsumerProbeModule,
      ...(options.extraImports ?? []),
    ],
    overrides: [
      { provide: PAYMENT_STATUS, useValue: payments },
      { provide: SHOP_DISCOUNTS, useValue: discounts },
      { provide: RealtimePublisher, useValue: realtime },
      ...(options.overrides ?? []),
    ],
    env: {
      CART_COOKIE_SECRET: KIT_CART_COOKIE_SECRET,
      STRIPE_WEBHOOK_SECRET: KIT_WEBHOOK_SECRET,
      STRIPE_WEBHOOK_SECRET_PREVIOUS: KIT_WEBHOOK_SECRET_PREVIOUS,
      ...options.env,
    },
  });

  const restores: Array<() => void> = [];
  const patch: OrdersTestApp['patch'] = (target, method, wrapper) => {
    const original = target[method];
    target[method] = wrapper(
      (typeof original === 'function'
        ? (original as AnyFn).bind(target)
        : original) as never,
    );
    const restore = () => {
      target[method] = original;
    };
    restores.push(restore);
    return restore;
  };

  return {
    ...base,
    payments,
    discounts,
    realtime,
    patch,
    async reset() {
      while (restores.length) restores.pop()!();
      payments.reset();
      discounts.reset();
      realtime.reset();
      await base.reset();
    },
  };
}

// ---------------------------------------------------------------- fixtures

export interface SeededShop {
  id: string;
}

export interface SeededCatalog {
  shop: SeededShop;
  products: SeededProduct[];
}

/** An active shop (no members needed) with products; stock and price are read back through the catalog's R1 service. */
export async function seedShopWithProducts(
  app: INestApplication,
  products: ProductSeed[],
  shopOptions: Parameters<typeof createShop>[2] = {},
): Promise<SeededCatalog> {
  const shop = await createShop(app, null, shopOptions);
  const created: SeededProduct[] = [];
  for (const seed of products)
    created.push(await createProduct(app, shop, seed));
  return { shop, products: created };
}

/** Current stock of products, read through the catalog's R1 service. */
export async function stockOf(
  app: INestApplication,
  ids: string[],
): Promise<Record<string, number>> {
  const found = await app.get(ProductQueryService).getProductsByIds(ids);
  return Object.fromEntries([...found].map(([id, p]) => [id, p.quantity]));
}

/** Inserts a `PENDING` order through the domain's own repository port, the way checkout's first transaction does. */
export async function seedPendingOrder(
  app: INestApplication,
  input: {
    userId: string;
    lines: Array<{
      productId: string;
      shopId: string;
      quantity: number;
      unitPriceMinor: number;
      title?: string;
    }>;
    now?: Date;
    currency?: string;
    key?: string;
  },
): Promise<OrderRecord> {
  const lines = input.lines.map((l) => ({
    productId: l.productId,
    shopId: l.shopId,
    title: l.title ?? 'Seeded item',
    quantity: l.quantity,
    unitPriceMinor: l.unitPriceMinor,
    discountMinor: 0,
    lineTotalMinor: l.unitPriceMinor * l.quantity,
  }));
  const bySubtotal = new Map<string, number>();
  for (const l of lines)
    bySubtotal.set(
      l.shopId,
      (bySubtotal.get(l.shopId) ?? 0) + l.lineTotalMinor,
    );
  const created = await app
    .get<OrderRepository>(ORDER_REPOSITORY)
    .createPending({
      id: uuidv7(),
      userId: input.userId,
      idempotencyKey: input.key ?? `seed-${randomUUID()}`,
      requestHash: 'seed',
      totalMinor: lines.reduce((s, l) => s + l.lineTotalMinor, 0),
      currency: input.currency ?? 'USD',
      now: input.now ?? app.get<Clock>(CLOCK).now(),
      items: lines,
      shopOrders: [...bySubtotal].map(([shopId, subtotalMinor]) => ({
        shopId,
        subtotalMinor,
      })),
    });
  if (!created) throw new Error('seedPendingOrder: key already used');
  return created;
}

/** One row of a table by order id, for assertions on persisted state (test code may read every table, IX.6). */
export async function rows<T extends object>(
  app: INestApplication,
  sql: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> {
  return app
    .get(Sequelize)
    .query<T>(sql, { type: QueryTypes.SELECT, replacements });
}

/** A statement that changes test data (price or status of a seeded product, ...). */
export async function exec(
  app: INestApplication,
  sql: string,
  replacements: Record<string, unknown> = {},
): Promise<void> {
  await app.get(Sequelize).query(sql, { replacements });
}

export const ordersOf = (app: INestApplication, userId: string) =>
  rows<{
    id: string;
    status: string;
    version: number;
    cancelReason: string | null;
    total: string;
    currency: string;
    reservedUntil: Date | null;
  }>(
    app,
    `SELECT "id", "status", "version", "cancelReason", "total", "currency", "reservedUntil" FROM "BisOrder" WHERE "userId" = :userId ORDER BY "createdAt", "id"`,
    { userId },
  );

export const orderRow = async (app: INestApplication, id: string) =>
  (
    await rows<{
      status: string;
      version: number;
      cancelReason: string | null;
      paymentRef: string | null;
      reservedUntil: Date | null;
      total: string;
    }>(
      app,
      `SELECT "status", "version", "cancelReason", "paymentRef", "reservedUntil", "total" FROM "BisOrder" WHERE "id" = :id`,
      { id },
    )
  )[0];

export const historyOf = (app: INestApplication, id: string) =>
  rows<{
    fromStatus: string | null;
    toStatus: string;
    reason: string | null;
    actor: string | null;
  }>(
    app,
    `SELECT "fromStatus", "toStatus", "reason", "actor" FROM "OrderEvent" WHERE "bisOrderId" = :id ORDER BY "id"`,
    { id },
  );

export const reservationsOf = (app: INestApplication, id: string) =>
  rows<{ productId: string; quantity: number; status: string }>(
    app,
    `SELECT "productId", "quantity", "status" FROM "StockReservation" WHERE "bisOrderId" = :id ORDER BY "productId"`,
    { id },
  );
