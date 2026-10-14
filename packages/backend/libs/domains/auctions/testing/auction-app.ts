import { Module, type INestApplication } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { ProductQueryService } from '@app/domains/catalog';
import { EntitlementsService } from '@app/domains/billing';
import { OrderCancelled, OrderPaid } from '@app/domains/orders';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { JobsTestProbe } from '@app/infrastructure/jobs/jobs-test-probe';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  createCatalogApp,
  type CatalogTestApp,
  type TestUser,
} from '@app/test/utils/catalog-app';
import {
  createProduct,
  type ProductSeed,
  type SeededProduct,
} from '@app/test/utils/catalog-fixtures';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import { AuctionsModule } from '../auctions.module';
import { AuctionsJobsModule } from '../auctions-worker.module';
import {
  AUCTION_CRASH_POINT,
  BID_DECISION_GATE,
  SimulatedCrash,
  type BidDecisionGate,
  type CrashPoint,
} from '../application/auction-test-seams';
import { AuctionsCoreModule } from '../auctions-core.module';
import { AuctionJobs } from '../infra/auction.jobs';
import { AuctionSettlementConsumer } from '../infra/auction-settlement.consumer';

/** A crash switch: `arm(name)` makes the next `hit(name)` throw once, as a process dying at that step would. */
export class CrashSwitch implements CrashPoint {
  private readonly armed = new Set<string>();
  readonly hits: string[] = [];

  arm(name: string): void {
    this.armed.add(name);
  }

  hit(name: string): void {
    this.hits.push(name);
    if (this.armed.delete(name)) throw new SimulatedCrash(name);
  }

  reset(): void {
    this.armed.clear();
    this.hits.length = 0;
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

/** The gate inside the bid decision (AS-32, AS-42): holds the bids of the armed bidders until the spec opens it. */
export class GateSwitch implements BidDecisionGate {
  readonly reached: Array<{ auctionId: string; bidderId: string }> = [];
  private gates = new Map<string, ReturnType<typeof createGate>>();

  /** The next bid of `bidderId` stops inside its decision until the returned gate is opened. */
  arm(bidderId: string): ReturnType<typeof createGate> {
    const gate = createGate();
    this.gates.set(bidderId, gate);
    return gate;
  }

  async hold(point: { auctionId: string; bidderId: string }): Promise<void> {
    this.reached.push(point);
    const gate = this.gates.get(point.bidderId);
    if (!gate) return;
    this.gates.delete(point.bidderId);
    await gate.wait();
  }

  reset(): void {
    for (const gate of this.gates.values()) gate.open();
    this.gates.clear();
    this.reached.length = 0;
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

/** S18's entitlement lookup, where a plan must be forced: a shop has `auctions` only when the spec grants it. */
export class FakeEntitlements {
  readonly granted = new Set<string>();

  get(_subjectType: 'USER' | 'SHOP', subjectId: string) {
    return Promise.resolve(
      this.granted.has(subjectId)
        ? { auctions: true, maxProducts: 1000, seats: 10 }
        : { auctions: false, maxProducts: 10, seats: 1 },
    );
  }

  invalidate(): Promise<void> {
    return Promise.resolve();
  }

  reset(): void {
    this.granted.clear();
  }
}

type AnyFn = (...args: never[]) => unknown;

export interface AuctionTestApp extends CatalogTestApp {
  realtime: FakeRealtimePublisher;
  entitlements: FakeEntitlements;
  crash: CrashSwitch;
  gate: GateSwitch;
  jobs: AuctionJobs;
  /** The `orders.events` consumer: specs hand it envelopes and call `project`. */
  consumer: AuctionSettlementConsumer;
  probe: JobsTestProbe;
  /** Moves the clock; access tokens expire with it, so every user the kit made signs in again. */
  setTime(at: Date): Promise<void>;
  /** A user whose token follows `setTime`. */
  user(): Promise<TestUser>;
  /**
   * Replaces `target[method]` with `wrapper(original)` until `reset()` or the returned `restore()`: the fault gates of
   * the plan (a refused outbox append, a tenancy lookup that times out) are installed this way on the real adapters.
   */
  patch<T extends object, K extends keyof T>(
    target: T,
    method: K,
    wrapper: (original: T[K] extends AnyFn ? T[K] : never) => T[K],
  ): () => void;
}

/** The orders consumer without the Kafka framework: specs call `project` directly (as the other domains' consumer specs do). */
@Module({
  imports: [AuctionsJobsModule, AuctionsCoreModule],
  providers: [AuctionSettlementConsumer],
  exports: [AuctionSettlementConsumer],
})
class AuctionsJobsProbeModule {}

/**
 * The real app the auctions specs run against: `AuctionsModule` (HTTP) and `AuctionsJobsModule` (job handlers, called
 * directly by the specs) next to the catalog and identity APIs, over real Postgres, Redis and DynamoDB Local, with the
 * production prefix, pipe, filter and the S50 limiter. Faked only at the system edges: the realtime transport, the
 * entitlement lookup and the clock (S21 test-plan.md).
 */
export async function createAuctionsApp(
  options: {
    extraImports?: unknown[];
    overrides?: Array<{ provide: unknown; useValue: unknown }>;
    env?: Record<string, string>;
    redisUrl?: string;
    structuredLogger?: boolean;
  } = {},
): Promise<AuctionTestApp> {
  const realtime = new FakeRealtimePublisher();
  const entitlements = new FakeEntitlements();
  const crash = new CrashSwitch();
  const gate = new GateSwitch();
  const base = await createCatalogApp({
    redisUrl: options.redisUrl,
    structuredLogger: options.structuredLogger,
    extraImports: [
      JobsModule,
      AuctionsModule,
      AuctionsJobsProbeModule,
      ...(options.extraImports ?? []),
    ],
    overrides: [
      { provide: RealtimePublisher, useValue: realtime },
      { provide: EntitlementsService, useValue: entitlements },
      { provide: AUCTION_CRASH_POINT, useValue: crash },
      { provide: BID_DECISION_GATE, useValue: gate },
      ...(options.overrides ?? []),
    ],
    env: {
      AUCTIONS_ALIAS_SECRET: 'auctions-kit-alias-secret-0123456789abcdef',
      ...options.env,
    },
  });

  const users: TestUser[] = [];
  const restores: Array<() => void> = [];
  const patch: AuctionTestApp['patch'] = (target, method, wrapper) => {
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
    realtime,
    entitlements,
    crash,
    gate,
    patch,
    jobs: base.app.get(AuctionJobs, { strict: false }),
    consumer: base.app.get(AuctionSettlementConsumer, { strict: false }),
    probe: new JobsTestProbe(base.app.get(Sequelize)),
    async user() {
      const user = await base.newUser();
      users.push(user);
      return user;
    },
    async setTime(at) {
      base.clock.set(at);
      for (const user of users) await base.reauth(user);
    },
    async reset() {
      while (restores.length) restores.pop()!();
      realtime.reset();
      entitlements.reset();
      crash.reset();
      gate.reset();
      users.length = 0;
      await base.reset();
    },
  };
}

// ---------------------------------------------------------------- fixtures

export interface Seller {
  owner: TestUser;
  shop: { id: string };
  products: SeededProduct[];
}

/** A shop with an owner, the `auctions` plan feature and products (EUR, as DS-1). */
export async function seedSeller(
  t: AuctionTestApp,
  products: ProductSeed[] = [{ priceMinor: 20_000, quantity: 3 }],
  shopOptions: Parameters<typeof createShop>[2] = {},
): Promise<Seller> {
  const owner = await t.user();
  const shop = await createShop(t.app, owner, shopOptions);
  t.entitlements.granted.add(shop.id);
  const created: SeededProduct[] = [];
  for (const seed of products)
    created.push(
      await createProduct(t.app, shop, { currency: 'EUR', ...seed }),
    );
  return { owner, shop, products: created };
}

/** Current stock of products, read through the catalog's R1 service. */
export async function stockOf(
  app: INestApplication,
  ids: string[],
): Promise<Record<string, number>> {
  const found = await app.get(ProductQueryService).getProductsByIds(ids);
  return Object.fromEntries([...found].map(([id, p]) => [id, p.quantity]));
}

/** Rows of a table for assertions on persisted state (test code may read every table, IX.6). */
export async function rows<T extends object>(
  app: INestApplication,
  sql: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> {
  return app
    .get(Sequelize)
    .query<T>(sql, { type: QueryTypes.SELECT, replacements });
}

/** A statement that changes test data. */
export async function exec(
  app: INestApplication,
  sql: string,
  replacements: Record<string, unknown> = {},
): Promise<void> {
  await app.get(Sequelize).query(sql, { replacements });
}

// ---------------------------------------------------------------- the fast store

/** Key patterns that match everything except keys starting with `prefix` (ACL globs, as the flash kit does). */
const patternsExcluding = (prefix: string): string[] =>
  [...prefix].map((_, i) => `${prefix.slice(0, i)}[^${prefix[i]}]*`);

export interface FastStore {
  /** The shared Redis refuses every key starting with `prefix` (an ACL rule), or accepts them again. */
  deny(prefix: string): Promise<void>;
  allow(): Promise<void>;
  /** Forgets every rate-limit counter (a spec that repeats one bidder's bids many times). */
  clearRateLimits(): Promise<void>;
  /** Flushes the whole shared store (AS-22). */
  flushAll(): Promise<void>;
}

export function fastStoreOf(app: INestApplication): FastStore {
  const redis = app.get(RedisService).client;
  return {
    async deny(prefix) {
      await redis.call(
        'ACL',
        'SETUSER',
        'default',
        'resetkeys',
        ...patternsExcluding(prefix).map((p) => `~${p}`),
      );
    },
    async allow() {
      await redis.call('ACL', 'SETUSER', 'default', 'allkeys');
    },
    async clearRateLimits() {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(
          cursor,
          'MATCH',
          'rl:*',
          'COUNT',
          1000,
        );
        cursor = next;
        if (keys.length) await redis.unlink(...keys);
      } while (cursor !== '0');
    },
    async flushAll() {
      await redis.flushall();
    },
  };
}

// ---------------------------------------------------------------- auction rows

export interface AuctionSeed {
  shopId: string;
  productId: string;
  id?: string;
  title?: string;
  currency?: string;
  startingPriceMinor?: number;
  minIncrementMinor?: number;
  reservePriceMinor?: number | null;
  startsAt: Date;
  endsAt: Date;
  originalEndsAt?: Date;
  status?: string;
  unitHeld?: boolean;
  version?: number;
  createdAt?: Date;
}

/**
 * An auction row written straight to the table, as DS-1 describes it (`OPEN`, the unit held, version 0): the bidding
 * specs start from a known auction without going through the scheduling route. Every bid, close and read afterwards
 * goes through the real code.
 */
export async function seedAuction(
  app: INestApplication,
  seed: AuctionSeed,
): Promise<string> {
  const id = seed.id ?? uuidv7();
  const starting = seed.startingPriceMinor ?? 1000;
  await exec(
    app,
    `INSERT INTO "Auction" ("id","shopId","productId","title","currency","startingPriceMinor","minIncrementMinor",
       "reservePriceMinor","startsAt","endsAt","originalEndsAt","status","priceMinor","version","unitHeld",
       "holdRequestedAt","createdAt","updatedAt")
     VALUES (:id,:shopId,:productId,:title,:currency,:starting,:increment,:reserve,:startsAt,:endsAt,:originalEndsAt,
       :status,:starting,:version,:unitHeld,:createdAt,:createdAt,:createdAt)`,
    {
      id,
      shopId: seed.shopId,
      productId: seed.productId,
      title: seed.title ?? 'Signed #001/100',
      currency: seed.currency ?? 'EUR',
      starting,
      increment: seed.minIncrementMinor ?? 500,
      reserve: seed.reservePriceMinor ?? null,
      startsAt: seed.startsAt,
      endsAt: seed.endsAt,
      originalEndsAt: seed.originalEndsAt ?? seed.endsAt,
      status: seed.status ?? 'OPEN',
      version: seed.version ?? 0,
      unitHeld: seed.unitHeld ?? true,
      createdAt:
        seed.createdAt ?? new Date(seed.startsAt.getTime() - 3_600_000),
    },
  );
  return id;
}

// ---------------------------------------------------------------- S10's events (contract-valid fixtures)

/** `order.paid` as `orders` publishes it: the consumer reads the order, the buyer, the total and the version. */
export function orderPaidEnvelope(order: {
  orderId: string;
  userId: string;
  totalMinor: number;
  orderVersion: number;
  currency?: string;
}) {
  return OrderPaid.create(order.orderId, order.orderVersion, {
    orderId: order.orderId,
    userId: order.userId,
    orderVersion: order.orderVersion,
    totalMinor: order.totalMinor,
    currency: order.currency ?? 'EUR',
    paymentRef: `pay_${order.orderId.slice(0, 8)}`,
    paidAt: new Date().toISOString(),
    lines: [],
    shopOrders: [],
  } as never);
}

/** `order.cancelled` (cancelled, lapsed or payment failed). */
export function orderCancelledEnvelope(order: {
  orderId: string;
  userId: string;
  orderVersion: number;
  reason?:
    'out_of_stock' | 'payment_failed' | 'hold_expired' | 'user_cancelled';
}) {
  return OrderCancelled.create(order.orderId, order.orderVersion, {
    orderId: order.orderId,
    userId: order.userId,
    orderVersion: order.orderVersion,
    reason: order.reason ?? 'hold_expired',
    previousStatus: 'RESERVED',
  } as never);
}
