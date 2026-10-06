import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { LRUCache } from 'lru-cache';
import { metrics } from '@opentelemetry/api';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle/shutdown-registry.service';
import { SingleFlight } from './single-flight';
import { jitterTtl, shouldRecomputeEarly } from './xfetch';
import { HotKeyDetector } from './hot-key-detector';
import { sleep } from '@app/common/core/backoff';

const INVALIDATION_CHANNEL = 'cache:invalidate';

interface Envelope<T> {
  /** null = negative-cache entry ("we checked, it doesn't exist"). */
  v: T | null;
  /** soft expiry (fresh until) */
  exp: number;
  /** hard expiry = exp + stale-while-revalidate window */
  hard: number;
  /** how long the loader took - feeds XFetch */
  delta: number;
}

export interface GetOrLoadOptions {
  ttlMs: number;
  /** Serve stale for this long after expiry while one caller refreshes in the background. */
  swrMs?: number;
  /** TTL for "not found" results (cache penetration). 0 disables negative caching. */
  negativeTtlMs?: number;
  /** In-process L1: always, only for detected hot keys (default), or never. */
  l1?: 'always' | 'hot' | 'never';
  l1TtlMs?: number;
}

/**
 * Cache-aside toolkit (SD-34, README #21-23). Read path:
 *   L1 (in-process LRU) → L2 (Redis) → loader, with
 *   - single-flight per instance + Redis lock across instances on misses (stampede),
 *   - XFetch early refresh + stale-while-revalidate (no latency spike at expiry),
 *   - jittered TTLs (avalanche), negative caching (penetration),
 *   - hot-key promotion to L1, invalidation broadcast to every instance's L1.
 * Writes never update the cache - they delete (`invalidate`), so a racing
 * slow reader can't resurrect a stale value for a full TTL.
 */
@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly l1 = new LRUCache<string, Envelope<unknown>>({ max: 10_000 });
  private readonly flights = new SingleFlight();
  private readonly hotKeys = new HotKeyDetector();
  private subscriber?: Redis;
  private readonly hits = metrics.getMeter('cache').createCounter('cache_requests_total');

  constructor(
    private readonly redis: RedisService,
    private readonly config: ApiConfigService,
    @Optional() shutdown?: ShutdownRegistry,
  ) {
    shutdown?.register({ name: 'cache.l1-invalidation.close', order: 80, run: async () => this.onModuleDestroy() });
  }

  async onModuleInit() {
    this.subscriber = new Redis(this.config.get('redis_url'), { maxRetriesPerRequest: null });
    await this.subscriber.subscribe(INVALIDATION_CHANNEL);
    this.subscriber.on('message', (_channel, key: string) => this.l1.delete(key));
  }

  async onModuleDestroy() {
    this.subscriber?.disconnect();
  }

  async getOrLoad<T>(key: string, loader: () => Promise<T | null>, options: GetOrLoadOptions): Promise<T | null> {
    const { l1 = 'hot' } = options;
    const now = Date.now();
    this.hotKeys.record(key);

    const useL1 = l1 === 'always' || (l1 === 'hot' && this.hotKeys.isHot(key));
    if (useL1) {
      const local = this.l1.get(key) as Envelope<T> | undefined;
      if (local && local.exp > now) return this.count('l1', local.v);
    }

    let cached: Envelope<T> | null = null;
    try {
      const raw = await this.redis.client.get(key);
      cached = raw ? (JSON.parse(raw) as Envelope<T>) : null;
    } catch (error) {
      // Redis down: degrade to the loader (single-flighted) rather than failing reads.
      this.logger.warn(`L2 read failed for ${key}: ${(error as Error).message}`);
      return this.flights.do(key, loader);
    }

    if (cached && now < cached.hard) {
      const stale = now >= cached.exp;
      if (stale || shouldRecomputeEarly(now, cached.exp, cached.delta)) {
        void this.flights.do(`refresh:${key}`, () => this.refresh(key, loader, options)).catch(() => undefined);
      }
      if (useL1) this.l1.set(key, cached, { ttl: options.l1TtlMs ?? 1_000 });
      return this.count(stale ? 'stale' : 'l2', cached.v);
    }

    this.count('miss', null);
    return this.flights.do(key, () => this.loadWithLock(key, loader, options));
  }

  /** Delete-on-write: L2 delete + broadcast so every instance drops its L1 copy. */
  async invalidate(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.redis.client.del(...keys);
    await Promise.all(keys.map((k) => this.redis.client.publish(INVALIDATION_CHANNEL, k)));
    keys.forEach((k) => this.l1.delete(k));
  }

  /** Cross-instance stampede guard: one instance computes, others wait briefly for its result. */
  private async loadWithLock<T>(key: string, loader: () => Promise<T | null>, options: GetOrLoadOptions): Promise<T | null> {
    const lockKey = `lock:${key}`;
    const acquired = await this.redis.client.set(lockKey, '1', 'PX', 5_000, 'NX').catch(() => 'OK');
    if (acquired === 'OK') {
      try {
        return await this.refresh(key, loader, options);
      } finally {
        await this.redis.client.del(lockKey).catch(() => undefined);
      }
    }

    for (let i = 0; i < 20; i++) {
      await sleep(25);
      const raw = await this.redis.client.get(key).catch(() => null);
      if (raw) return (JSON.parse(raw) as Envelope<T>).v;
    }
    return this.refresh(key, loader, options); // lock holder is slow or died - compute ourselves
  }

  private async refresh<T>(key: string, loader: () => Promise<T | null>, options: GetOrLoadOptions): Promise<T | null> {
    const started = Date.now();
    const value = await loader();
    const delta = Date.now() - started;

    if (value === null && !options.negativeTtlMs) return null;

    const ttl = jitterTtl(value === null ? options.negativeTtlMs! : options.ttlMs);
    const envelope: Envelope<T> = { v: value, exp: Date.now() + ttl, hard: Date.now() + ttl + (options.swrMs ?? 0), delta };
    await this.redis.client
      .set(key, JSON.stringify(envelope), 'PX', ttl + (options.swrMs ?? 0))
      .catch((e) => this.logger.warn(`L2 write failed for ${key}: ${e.message}`));
    return value;
  }

  private count<T>(outcome: string, value: T): T {
    this.hits.add(1, { outcome });
    return value;
  }
}
