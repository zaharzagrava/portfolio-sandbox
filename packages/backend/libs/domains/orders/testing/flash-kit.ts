import type { INestApplication } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type {
  SeededProduct,
  ProductSeed,
} from '@app/test/utils/catalog-fixtures';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import {
  FLASH_CRASH_POINT,
  FLASH_RANDOM,
  FLASH_SALE_DIRECTORY,
  SimulatedCrash,
  type CrashPoint,
  type FlashRandom,
} from '../domain/flash-ports';
import { FlashLifecycleService } from '../application/flash-lifecycle.service';
import { FlashSaleJobs } from '../infra/flash-sale.jobs';
import { CachedFlashSaleDirectory } from '../infra/flash-sale.directory';
import { createOrdersApp, type OrdersTestApp } from './orders-app';

/** A crash switch: `arm(name)` makes the next `hit(name)` throw once, as a process dying at that step would. */
export class CrashSwitch implements CrashPoint {
  private readonly armed = new Set<string>();
  readonly hits: string[] = [];

  arm(name: string): void {
    this.armed.add(name);
  }

  /** Optional gate: `hit(name)` waits for it (a latch the spec opens later) before checking for a crash. */
  readonly gates = new Map<string, () => Promise<void>>();

  async hit(name: string): Promise<void> {
    this.hits.push(name);
    await this.gates.get(name)?.();
    if (this.armed.delete(name)) throw new SimulatedCrash(name);
  }

  reset(): void {
    this.armed.clear();
    this.gates.clear();
    this.hits.length = 0;
  }
}

/** A seeded generator (mulberry32) so the start bucket and `Retry-After` are reproducible. */
export function seededRandom(seed: number): FlashRandom {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every key a sale may hold: `flash:{<saleId>:…}` (the hash tag always starts with the sale id). */
const salePattern = (saleId: string) => `flash:{${saleId}:*`;

export interface FlashTestApp extends OrdersTestApp {
  crash: CrashSwitch;
  /** Replaces the random source (default: a fixed seed). */
  seedRandom(seed: number): void;
  jobs: FlashSaleJobs;
  lifecycle: FlashLifecycleService;
  directory: CachedFlashSaleDirectory;
  /** Units in the buckets of a sale, as the store holds them (a missing bucket reads 0). */
  buckets(saleId: string, count: number): Promise<number[]>;
  quotaOf(saleId: string, userId: string): Promise<number>;
  /** Every `flash:` key of a sale. */
  keysOf(saleId: string): Promise<string[]>;
  /** The fast store refuses every `flash:` key (an ACL rule on the shared Redis), or accepts them again. */
  denyStore(options?: { except?: 'admission' }): Promise<void>;
  allowStore(): Promise<void>;
  /** Forgets every rate-limit counter (a spec that repeats one buyer's checkouts many times). */
  clearRateLimits(): Promise<void>;
  /** Every Redis command the server saw while `fn` ran (a MONITOR connection); observation only. */
  recordRedisCommands<T>(
    fn: () => Promise<T>,
  ): Promise<{ result: T; commands: string[][] }>;
  /** Commands the Redis server counted since the last call (by command name), from `INFO commandstats`. */
  commandCounts(): Promise<Record<string, number>>;
  redis: RedisService['client'];
}

/** The orders app plus the doubles and readers of the flash specs (S11 test kit). */
export async function createFlashApp(
  options: Parameters<typeof createOrdersApp>[0] = {},
): Promise<FlashTestApp> {
  const crash = new CrashSwitch();
  let random = seededRandom(7);
  const randomProxy: FlashRandom = () => random();
  // Hundreds of buyers at once in a busy process can take over the 200 ms the rate-limit store gets per call; the
  // breaker then opens, and with the frozen test clock it never closes again. A wider limit only for this app
  // (set while it starts, put back after: the setting is read at start-up).
  const timeoutKey = 'RATE_LIMIT_STORE_TIMEOUT_MS';
  const timeoutBefore = process.env[timeoutKey];
  process.env[timeoutKey] ??= '3000';
  let base: Awaited<ReturnType<typeof createOrdersApp>>;
  try {
    base = await createOrdersApp({
      ...options,
      overrides: [
        { provide: FLASH_CRASH_POINT, useValue: crash },
        { provide: FLASH_RANDOM, useValue: randomProxy },
        ...(options.overrides ?? []),
      ],
    });
  } finally {
    if (timeoutBefore === undefined) delete process.env[timeoutKey];
    else process.env[timeoutKey] = timeoutBefore;
  }
  const redis = base.app.get(RedisService).client;
  let last: Record<string, number> = {};
  const parseStats = async () => {
    const info = await redis.info('commandstats');
    const out: Record<string, number> = {};
    for (const line of info.split('\n')) {
      const m = /^cmdstat_([a-z_|]+):calls=(\d+)/.exec(line.trim());
      if (m) out[m[1]] = Number(m[2]);
    }
    return out;
  };
  const denyPatterns = [
    '[^f]*',
    'f[^l]*',
    'fl[^a]*',
    'fla[^s]*',
    'flas[^h]*',
    'flash[^:]*',
  ];
  const allowStore = async () => {
    await redis.call('ACL', 'SETUSER', 'default', 'allkeys');
  };
  return {
    ...base,
    crash,
    redis,
    seedRandom: (seed) => {
      random = seededRandom(seed);
    },
    jobs: base.app.get(FlashSaleJobs, { strict: false }),
    lifecycle: base.app.get(FlashLifecycleService, { strict: false }),
    directory: base.app.get<CachedFlashSaleDirectory>(FLASH_SALE_DIRECTORY, {
      strict: false,
    }),
    async buckets(saleId, count) {
      const values = await Promise.all(
        Array.from({ length: count }, (_, b) =>
          redis.get(`flash:{${saleId}:${b}}:stock`),
        ),
      );
      return values.map((v) => (v === null ? 0 : Number(v)));
    },
    async quotaOf(saleId, userId) {
      return Number(
        (await redis.hget(`flash:{${saleId}:quota:${userId}}`, 'total')) ?? 0,
      );
    },
    async keysOf(saleId) {
      const found: string[] = [];
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(
          cursor,
          'MATCH',
          salePattern(saleId),
          'COUNT',
          1000,
        );
        cursor = next;
        found.push(...keys);
      } while (cursor !== '0');
      return found.sort();
    },
    async denyStore(options = {}) {
      const allowed = [
        ...denyPatterns,
        ...(options.except === 'admission' ? ['flash:{*:adm}'] : []),
      ];
      await redis.call(
        'ACL',
        'SETUSER',
        'default',
        'resetkeys',
        ...allowed.map((p) => `~${p}`),
      );
    },
    allowStore,
    async recordRedisCommands(fn) {
      const monitor = await redis.monitor();
      const commands: string[][] = [];
      // MONITOR sees every database on the server (other shards too): keep only this app's database
      const db = Number(redis.options.db ?? 0);
      monitor.on(
        'monitor',
        (_time: string, args: string[], _source: string, database: string) => {
          if (Number(database) === db) commands.push(args);
        },
      );
      try {
        const result = await fn();
        await new Promise((resolve) => setTimeout(resolve, 100)); // the monitor stream trails the commands slightly
        return { result, commands };
      } finally {
        monitor.disconnect();
      }
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
    async commandCounts() {
      const now = await parseStats();
      const diff: Record<string, number> = {};
      for (const [k, v] of Object.entries(now)) diff[k] = v - (last[k] ?? 0);
      last = now;
      return diff;
    },
    async reset() {
      await allowStore();
      crash.reset();
      random = seededRandom(7);
      await base.reset();
    },
  };
}

export interface Seller {
  owner: Awaited<ReturnType<OrdersTestApp['newUser']>>;
  shop: { id: string };
  products: SeededProduct[];
}

/** A shop with an owner (who may schedule sales) and products. */
export async function seedSeller(
  t: OrdersTestApp,
  products: ProductSeed[],
  shopOptions: Parameters<typeof createShop>[2] = {},
): Promise<Seller> {
  const owner = await t.newUser();
  const shop = await createShop(t.app as INestApplication, owner, shopOptions);
  const created: SeededProduct[] = [];
  for (const seed of products)
    created.push(await createProduct(t.app as INestApplication, shop, seed));
  return { owner, shop, products: created };
}
