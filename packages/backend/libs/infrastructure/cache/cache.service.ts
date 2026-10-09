import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { Clock, CLOCK, SystemClock } from '@app/common/core/clock';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { RequestContext } from '@app/infrastructure/context/request-context.service';
import {
  BroadcastMessage,
  encodeDrop,
  encodeVersionedDrop,
  INVALIDATION_CHANNEL,
  InvalidationBroadcast,
} from './broadcast';
import {
  CACHE_TOOLKIT_CONFIG,
  CacheToolkitConfig,
  resolveCacheConfig,
} from './cache.config';
import { InvalidLoaderResult } from './cache.errors';
import { CacheLog } from './cache-log';
import { cacheMetrics, CacheMetrics, CacheOutcome } from './cache-metrics';
import {
  keyNamespace,
  minimumKey,
  recomputeLockKey,
  validateKey,
} from './cache-key';
import {
  GetOrLoadOptions,
  ResolvedOptions,
  resolveGetOrLoadOptions,
  validateBatchKeys,
  validateInvalidateKeys,
  validateMinimumRetention,
  validateVersion,
  DEFAULT_MINIMUM_RETENTION_MS,
} from './cache-options';
import {
  GUARDED_STORE,
  INVALIDATE_IF_OLDER,
  RELEASE_LOCK,
  runScript,
} from './cache-scripts';
import {
  assertJsonValue,
  encodeEnvelope,
  Envelope,
  parseEnvelope,
} from './entry-codec';
import { HotKeyDetector } from './hot-key-detector';
import { L1Cache } from './l1-cache';
import { LoaderBulkhead } from './loader-bulkhead';
import { RANDOM_SOURCE, SystemRandom } from './random-source';
import type { RandomSource } from './random-source';
import { RefreshTracker } from './refresh-tracker';
import { SingleFlight } from './single-flight';
import { StoreGuard } from './store-guard';
import { jitterTtl, shouldRecomputeEarly } from './xfetch';

export type { GetOrLoadOptions } from './cache-options';

/** Keys per UNLINK/PUBLISH pair: 5,000 keys take 10 commands in one pipeline (FR-019). */
const INVALIDATE_CHUNK = 1_000;
/** Real-time pause between a follower's looks at the store; jittered by the random source. */
const FOLLOWER_POLL_MS = 20;
const OVERSIZE_LOG_INTERVAL_MS = 60_000;
const DEGRADED_LOG_INTERVAL_MS = 10_000;

type LockAttempt =
  | { state: 'acquired'; token: string }
  | { state: 'contended' }
  | { state: 'unavailable' };

interface LoadContext {
  useL1: boolean;
  /** A stale entry past its SWR window that may still be served if the loader fails. */
  stale?: Envelope<unknown>;
}

export interface CacheStats {
  l1Entries: number;
  l1Bytes: number;
  inFlight: number;
  pendingRefreshes: number;
  trackedHotKeys: number;
  loadersRunning: number;
  loadersQueued: number;
  broadcastHealthy: boolean;
  breaker: 'closed' | 'open' | 'half-open';
}

/**
 * Cache-aside toolkit (SD-34, README #21-23). Read path:
 *   L1 (in-process LRU) → L2 (Redis) → loader, with
 *   - single-flight per instance + a Redis lock across instances on misses and refreshes (stampede),
 *   - XFetch early refresh + stale-while-revalidate + stale-if-error,
 *   - jittered TTLs (avalanche), negative caching (penetration),
 *   - a timeout and circuit breaker on every store call, and a cap on running loaders (a cache outage slows
 *     reads, it never fails them),
 *   - hot-key promotion to L1, used only while the invalidation broadcast is healthy.
 * Writers never store: they delete (`invalidate`) or delete-if-older (`invalidateIfOlder`), so a racing slow
 * reader cannot resurrect a stale value; there is deliberately no `set`.
 */
@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly cfg: CacheToolkitConfig;
  private readonly log: CacheLog;
  private readonly metrics: CacheMetrics;
  private readonly guard: StoreGuard;
  private readonly bulkhead: LoaderBulkhead;
  private readonly l1: L1Cache;
  private readonly flights = new SingleFlight();
  private readonly refreshes = new RefreshTracker();
  private readonly hotKeys: HotKeyDetector;
  private readonly broadcast: InvalidationBroadcast;
  private closing = false;

  constructor(
    private readonly redis: RedisService,
    config: ApiConfigService,
    @Optional() shutdown?: ShutdownRegistry,
    @Optional() @Inject(CLOCK) clock?: Clock,
    @Optional() @Inject(RANDOM_SOURCE) random?: RandomSource,
    @Optional()
    @Inject(CACHE_TOOLKIT_CONFIG)
    toolkitConfig?: Partial<CacheToolkitConfig>,
    @Optional() requestContext?: RequestContext,
  ) {
    this.clock = clock ?? new SystemClock();
    this.random = random ?? new SystemRandom();
    this.cfg = resolveCacheConfig(toolkitConfig);
    this.metrics = cacheMetrics();
    this.log = new CacheLog(this.clock, () => requestContext?.requestId);
    this.guard = new StoreGuard(this.clock, this.cfg, this.log);
    this.bulkhead = new LoaderBulkhead(
      this.cfg.loaderConcurrency,
      this.cfg.loaderQueueWaitMs,
    );
    this.l1 = new L1Cache(
      this.cfg.l1MaxEntries,
      this.cfg.l1MaxBytes,
      this.clock,
    );
    this.hotKeys = new HotKeyDetector(this.clock, this.random);
    this.broadcast = new InvalidationBroadcast(
      config.get('redis_url'),
      (message) => this.onBroadcast(message),
      () => {
        this.l1.clear();
        this.syncL1Gauge();
      },
      this.log,
    );

    shutdown?.register({
      name: 'cache.toolkit.close',
      order: 80,
      timeoutMs: this.cfg.refreshShutdownWaitMs + 2_000,
      run: () => this.close(),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.broadcast.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  /** Probes for specs and health pages; nothing here is on a hot path. */
  stats(): CacheStats {
    const loaders = this.bulkhead.stats();
    return {
      l1Entries: this.l1.size,
      l1Bytes: this.l1.bytes,
      inFlight: this.flights.size(),
      pendingRefreshes: this.refreshes.size(),
      trackedHotKeys: this.hotKeys.tracked(),
      loadersRunning: loaders.running,
      loadersQueued: loaders.queued,
      broadcastHealthy: this.broadcast.healthy,
      breaker: this.guard.state(),
    };
  }

  /** Whether this instance holds a live L1 copy of `key`. */
  l1Has(key: string): boolean {
    return this.l1.has(key);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Reads

  async getOrLoad<T>(
    key: string,
    loader: () => Promise<T | null>,
    options: GetOrLoadOptions<T>,
  ): Promise<T | null> {
    validateKey(key);
    const opts = this.resolve(options);
    const ns = keyNamespace(key);

    if (this.closing) return this.loadDegraded(ns, loader);

    this.hotKeys.record(key);
    const useL1 = this.l1Allowed(key, opts);
    if (useL1) {
      const local = this.l1.get(key);
      if (local) {
        this.count(ns, 'l1');
        return local.v as T | null;
      }
    }

    let raw: string | null;
    try {
      raw = await this.guard.run(
        () => this.redis.client.get(key),
        opts.timeoutMs,
      );
    } catch (error) {
      return this.degraded(key, ns, loader, error);
    }

    const parsed = parseEnvelope<T>(raw);
    const now = this.clock.nowMs();
    const ctx: LoadContext = { useL1 };

    if (parsed.kind === 'ok') {
      const env = parsed.envelope;
      if (env.v === null) {
        if (now < env.exp) {
          this.fillL1(key, env, raw!, opts, useL1);
          this.count(ns, 'negative');
          return null;
        }
        // an expired negative entry is a miss: negative entries ignore SWR and stale-if-error (AS-23)
      } else if (now < env.exp) {
        this.fillL1(key, env, raw!, opts, useL1);
        this.count(ns, 'l2');
        if (
          shouldRecomputeEarly(now, env.exp, env.delta, 1, () =>
            this.random.next(),
          )
        )
          this.refreshInBackground(key, loader, opts, env.exp);
        return env.v;
      } else if (now < env.exp + opts.swrMs) {
        this.count(ns, 'stale');
        this.refreshInBackground(key, loader, opts, env.exp);
        return env.v;
      } else if (now < env.hard) {
        ctx.stale = env;
      }
    }

    if (parsed.kind === 'corrupt') {
      this.count(ns, 'corrupt');
      this.log.warnLimited(
        ns,
        'corrupt',
        DEGRADED_LOG_INTERVAL_MS,
        'corrupt cache entry replaced',
        key,
      );
    } else {
      this.count(ns, 'miss');
    }
    return this.flights.do(key, () =>
      this.loadAndStore(key, loader, opts, ctx),
    );
  }

  /**
   * Batch read: one store read for all keys, one loader call for the missing ones (input order), results in
   * input order. Loads already in flight for a key (from `getOrLoad` or another batch) are shared, not repeated.
   */
  async getOrLoadMany<T>(
    keys: string[],
    batchLoader: (missing: string[]) => Promise<Map<string, T | null>>,
    options: GetOrLoadOptions<T>,
  ): Promise<(T | null)[]> {
    validateBatchKeys(keys);
    keys.forEach(validateKey);
    const opts = this.resolve(options);
    const unique = [...new Set(keys)];
    if (unique.length === 0) return [];

    const results = new Map<string, T | null>();
    const pending = new Map<string, Promise<T | null>>();
    const toLoad: string[] = [];
    let degraded = this.closing;
    let raws: (string | null)[] = [];

    if (!degraded) {
      try {
        raws = await this.guard.run(
          () => this.redis.client.mget(...unique),
          opts.timeoutMs,
        );
      } catch (error) {
        degraded = true;
        this.log.warnLimited(
          keyNamespace(unique[0]),
          'degraded',
          DEGRADED_LOG_INTERVAL_MS,
          `cache store unavailable: ${(error as Error).message}`,
        );
      }
    }

    const now = this.clock.nowMs();
    unique.forEach((key, index) => {
      const ns = keyNamespace(key);
      if (degraded) {
        this.count(ns, 'degraded');
      } else {
        const parsed = parseEnvelope<T>(raws[index]);
        if (parsed.kind === 'ok') {
          const env = parsed.envelope;
          if (env.v === null && now < env.exp) {
            this.count(ns, 'negative');
            results.set(key, null);
            return;
          }
          if (env.v !== null && now < env.exp) {
            this.count(ns, 'l2');
            results.set(key, env.v);
            return;
          }
          if (env.v !== null && now < env.exp + opts.swrMs) {
            this.count(ns, 'stale');
            results.set(key, env.v);
            this.refreshInBackground(
              key,
              async () => (await batchLoader([key])).get(key) ?? null,
              opts,
              env.exp,
            );
            return;
          }
        }
        this.count(ns, parsed.kind === 'corrupt' ? 'corrupt' : 'miss');
      }
      if (this.flights.has(key)) {
        pending.set(
          key,
          this.flights.do(key, () => Promise.reject(new Error('unreachable'))),
        );
      } else {
        toLoad.push(key);
      }
    });

    if (toLoad.length > 0) {
      const batch = this.loadBatch(toLoad, batchLoader, opts, degraded);
      batch.catch(() => undefined); // surfaced through the per-key flights below
      for (const key of toLoad)
        pending.set(
          key,
          this.flights.do(key, async () => {
            const loaded = await batch;
            return (loaded.get(key) ?? null) as T | null;
          }),
        );
    }

    await Promise.all(
      [...pending.entries()].map(async ([key, promise]) => {
        results.set(key, await promise);
      }),
    );
    return keys.map((key) => results.get(key) ?? null);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Invalidation (writers delete, they never store)

  /**
   * Delete-on-write: UNLINK from the store, broadcast so every instance drops its L1 copy, evict the local copy
   * even when the store fails. Never throws on store failure (a failed delete must not fail a business write).
   */
  async invalidate(
    keys: string[],
  ): Promise<{ l2: 'ok' | 'failed'; deleted: number }> {
    validateInvalidateKeys(keys);
    keys.forEach(validateKey);
    const unique = [...new Set(keys)];
    if (unique.length === 0) return { l2: 'ok', deleted: 0 };

    for (const key of unique) this.l1.delete(key);
    this.syncL1Gauge();

    try {
      const deleted = await this.guard.run(async () => {
        const pipeline = this.redis.client.pipeline();
        for (let i = 0; i < unique.length; i += INVALIDATE_CHUNK) {
          const chunk = unique.slice(i, i + INVALIDATE_CHUNK);
          pipeline.unlink(...chunk);
          pipeline.publish(INVALIDATION_CHANNEL, encodeDrop(chunk));
        }
        const replies = (await pipeline.exec()) ?? [];
        let total = 0;
        replies.forEach(([error, value], index) => {
          if (error) throw error;
          if (index % 2 === 0) total += Number(value);
        });
        return total;
      });
      this.metrics.invalidations.add(1, { result: 'ok' });
      return { l2: 'ok', deleted };
    } catch (error) {
      this.metrics.invalidations.add(1, { result: 'failed' });
      this.log.warnLimited(
        keyNamespace(unique[0]),
        'invalidate-failed',
        DEGRADED_LOG_INTERVAL_MS,
        `invalidate failed for ${unique.length} key(s): ${(error as Error).message}`,
      );
      return { l2: 'failed', deleted: 0 };
    }
  }

  /**
   * Version-guarded invalidation: deletes the entry when it is older than `version` (or unversioned) and raises
   * the key's minimum accepted version, atomically; never lowers a minimum. Throws `CacheUnavailable` when the
   * store cannot be reached (the caller's consumer retries).
   */
  async invalidateIfOlder(
    key: string,
    version: number,
    options: { minimumRetentionMs?: number } = {},
  ): Promise<{ outcome: 'applied' | 'skipped' }> {
    validateKey(key);
    validateVersion(version);
    const retention =
      options.minimumRetentionMs === undefined
        ? (this.cfg.minimumRetentionMs ?? DEFAULT_MINIMUM_RETENTION_MS)
        : validateMinimumRetention(options.minimumRetentionMs);

    const now = this.clock.nowMs();
    const outcome = (await this.guard.run(() =>
      runScript(
        this.redis.client,
        INVALIDATE_IF_OLDER,
        [key, minimumKey(key)],
        [version, retention, now, now + retention],
      ),
    )) as 'applied' | 'skipped';

    this.metrics.invalidations.add(1, { result: outcome });
    if (outcome === 'applied') {
      this.l1.dropIfOlder(key, version);
      this.syncL1Gauge();
      try {
        await this.guard.run(() =>
          this.redis.client.publish(
            INVALIDATION_CHANNEL,
            encodeVersionedDrop(key, version),
          ),
        );
      } catch (error) {
        this.log.warnLimited(
          keyNamespace(key),
          'broadcast-failed',
          DEGRADED_LOG_INTERVAL_MS,
          `versioned broadcast failed: ${(error as Error).message}`,
          key,
        );
      }
    }
    return { outcome };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Loading

  /** Miss path, run inside the per-key flight: take the recompute lock, load, store. */
  private async loadAndStore<T>(
    key: string,
    loader: () => Promise<T | null>,
    opts: ResolvedOptions<T>,
    ctx: LoadContext,
  ): Promise<T | null> {
    const ns = keyNamespace(key);
    let lock = await this.tryLock(key, opts.timeoutMs);
    try {
      if (lock.state === 'contended') {
        const outcome = await this.followLeader<T>(key, opts);
        if (outcome.kind === 'value') {
          this.count(ns, 'l2');
          return outcome.envelope.v;
        }
        lock = outcome.lock; // acquired after the leader vanished, or unavailable/contended after the budget
      } else if (lock.state === 'acquired') {
        const existing = await this.peekFresh<T>(key, opts.timeoutMs);
        if (existing) {
          this.count(ns, 'l2');
          return existing.v;
        }
      }
      return await this.loadFresh(key, loader, opts, ctx);
    } finally {
      if (lock.state === 'acquired') await this.releaseLock(key, lock.token);
    }
  }

  /**
   * The lock is held by someone else: poll the store for their result for up to `followerWaitMs` (injected
   * clock), taking the lock over if its holder vanished. After the budget, load without the lock.
   */
  private async followLeader<T>(
    key: string,
    opts: ResolvedOptions<T>,
  ): Promise<
    | { kind: 'value'; envelope: Envelope<T> }
    | { kind: 'load'; lock: LockAttempt }
  > {
    const deadline = this.clock.nowMs() + this.cfg.followerWaitMs;
    for (;;) {
      await this.pause(
        FOLLOWER_POLL_MS + Math.floor(this.random.next() * FOLLOWER_POLL_MS),
      );
      if (this.closing) return { kind: 'load', lock: { state: 'unavailable' } };
      const envelope = await this.peekFresh<T>(key, opts.timeoutMs);
      if (envelope) return { kind: 'value', envelope };
      if (this.clock.nowMs() >= deadline)
        return { kind: 'load', lock: { state: 'contended' } };
      const lock = await this.tryLock(key, opts.timeoutMs);
      if (lock.state !== 'contended') return { kind: 'load', lock };
    }
  }

  /** Runs the loader (inside the bulkhead), then stores the result unless the store refuses it. */
  private async loadFresh<T>(
    key: string,
    loader: () => Promise<T | null>,
    opts: ResolvedOptions<T>,
    ctx: LoadContext,
  ): Promise<T | null> {
    const ns = keyNamespace(key);
    let loaded: { value: T | null; delta: number };
    try {
      loaded = await this.runLoader(ns, loader);
    } catch (error) {
      const stale = ctx.stale;
      if (
        stale &&
        !(error instanceof InvalidLoaderResult) &&
        this.clock.nowMs() < stale.exp + opts.staleIfErrorMs
      ) {
        this.count(ns, 'stale_error');
        this.log.warnLimited(
          ns,
          'stale-error',
          DEGRADED_LOG_INTERVAL_MS,
          `loader failed, serving stale: ${(error as Error).message}`,
          key,
        );
        return stale.v as T | null;
      }
      throw error;
    }
    await this.persistLoaded(key, loaded.value, loaded.delta, opts, ctx.useL1);
    return loaded.value;
  }

  /** Loader inside the bulkhead, timed on the injected clock, result validated. */
  private async runLoader<T>(
    ns: string,
    loader: () => Promise<T | null>,
  ): Promise<{ value: T | null; delta: number }> {
    return this.bulkhead.run(async () => {
      const started = this.clock.nowMs();
      this.metrics.loaderCalls.add(1, { namespace: ns });
      let value: T | null;
      try {
        value = await loader();
      } finally {
        const delta = this.clock.nowMs() - started;
        this.metrics.loaderDuration.record(delta / 1000, { namespace: ns });
      }
      assertJsonValue(value);
      return { value, delta: this.clock.nowMs() - started };
    });
  }

  /** Store failed or the store is down: answer from the loader alone, store nothing (FR-024). */
  private async degraded<T>(
    key: string,
    ns: string,
    loader: () => Promise<T | null>,
    error: unknown,
  ): Promise<T | null> {
    this.count(ns, 'degraded');
    this.log.warnLimited(
      ns,
      'degraded',
      DEGRADED_LOG_INTERVAL_MS,
      `cache store unavailable, reading from the source: ${(error as Error).message}`,
      key,
    );
    return this.flights.do(key, () => this.loadDegraded(ns, loader));
  }

  private async loadDegraded<T>(
    ns: string,
    loader: () => Promise<T | null>,
  ): Promise<T | null> {
    return (await this.runLoader(ns, loader)).value;
  }

  private async loadBatch<T>(
    keys: string[],
    batchLoader: (missing: string[]) => Promise<Map<string, T | null>>,
    opts: ResolvedOptions<T>,
    degraded: boolean,
  ): Promise<Map<string, T | null>> {
    const ns = keyNamespace(keys[0]);
    const loaded = await this.bulkhead.run(async () => {
      const started = this.clock.nowMs();
      this.metrics.loaderCalls.add(1, { namespace: ns });
      try {
        return await batchLoader(keys);
      } finally {
        this.metrics.loaderDuration.record(
          (this.clock.nowMs() - started) / 1000,
          {
            namespace: ns,
          },
        );
      }
    });
    const delta = 0;
    const values = new Map<string, T | null>();
    for (const key of keys) {
      const value = loaded.get(key) ?? null;
      assertJsonValue(value);
      values.set(key, value);
    }
    if (!degraded) await this.persistLoadedMany(values, delta, opts);
    return values;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Storing

  private buildEnvelope<T>(
    value: T | null,
    delta: number,
    opts: ResolvedOptions<T>,
  ): Envelope<T> | undefined {
    const negative = value === null;
    if (negative && !opts.negativeTtlMs) return undefined;
    const ttl = Math.max(
      1,
      jitterTtl(negative ? opts.negativeTtlMs : opts.ttlMs, opts.jitter, () =>
        this.random.next(),
      ),
    );
    const now = this.clock.nowMs();
    const ver = negative ? undefined : this.versionOf(opts, value);
    return {
      v: value,
      exp: now + ttl,
      hard:
        now + ttl + (negative ? 0 : Math.max(opts.swrMs, opts.staleIfErrorMs)),
      delta,
      ...(ver !== undefined ? { ver } : {}),
    };
  }

  private versionOf<T>(
    opts: ResolvedOptions<T>,
    value: T | null,
  ): number | undefined {
    if (value === null || !opts.versionOf) return undefined;
    const version = opts.versionOf(value);
    return Number.isSafeInteger(version) && version >= 0 ? version : undefined;
  }

  /** Not a public write: it stores what a loader returned, behind the minimum-version guard. */
  private async persistLoaded<T>(
    key: string,
    value: T | null,
    delta: number,
    opts: ResolvedOptions<T>,
    useL1: boolean,
  ): Promise<void> {
    const ns = keyNamespace(key);
    const env = this.buildEnvelope(value, delta, opts);
    if (!env) return;
    const encoded = encodeEnvelope(env, opts.maxEntryBytes);
    if (encoded.kind === 'oversize') {
      this.count(ns, 'oversize');
      this.log.warnLimited(
        ns,
        'oversize',
        OVERSIZE_LOG_INTERVAL_MS,
        `entry of ${encoded.bytes} bytes exceeds the ${opts.maxEntryBytes} byte cap and is not cached`,
        key,
      );
      return;
    }
    try {
      const result = (await this.guard.run(
        () =>
          runScript(
            this.redis.client,
            GUARDED_STORE,
            [key, minimumKey(key)],
            [
              encoded.payload,
              Math.max(1, env.hard - this.clock.nowMs()),
              env.ver ?? '',
              this.clock.nowMs(),
            ],
          ),
        opts.timeoutMs,
      )) as string;
      if (result === 'ok') this.fillL1(key, env, encoded.payload, opts, useL1);
      else this.count(ns, result as CacheOutcome);
    } catch (error) {
      this.log.warnLimited(
        ns,
        'store-failed',
        DEGRADED_LOG_INTERVAL_MS,
        `cache write failed: ${(error as Error).message}`,
        key,
      );
    }
  }

  /** One round trip for all new entries of a batch. */
  private async persistLoadedMany<T>(
    values: Map<string, T | null>,
    delta: number,
    opts: ResolvedOptions<T>,
  ): Promise<void> {
    const writes: { key: string; env: Envelope<T>; payload: string }[] = [];
    for (const [key, value] of values) {
      const ns = keyNamespace(key);
      const env = this.buildEnvelope(value, delta, opts);
      if (!env) continue;
      const encoded = encodeEnvelope(env, opts.maxEntryBytes);
      if (encoded.kind === 'oversize') {
        this.count(ns, 'oversize');
        this.log.warnLimited(
          ns,
          'oversize',
          OVERSIZE_LOG_INTERVAL_MS,
          `entry of ${encoded.bytes} bytes exceeds the cap and is not cached`,
          key,
        );
        continue;
      }
      writes.push({ key, env, payload: encoded.payload });
    }
    if (writes.length === 0) return;
    try {
      const replies = await this.guard.run(async () => {
        const pipeline = this.redis.client.pipeline();
        for (const { key, env, payload } of writes)
          pipeline.eval(
            GUARDED_STORE.source,
            2,
            key,
            minimumKey(key),
            payload,
            Math.max(1, env.hard - this.clock.nowMs()),
            env.ver ?? '',
            this.clock.nowMs(),
          );
        return (await pipeline.exec()) ?? [];
      }, opts.timeoutMs);
      replies.forEach(([error, result], index) => {
        if (error) return;
        const { key } = writes[index];
        if (result !== 'ok')
          this.count(keyNamespace(key), result as CacheOutcome);
      });
    } catch (error) {
      this.log.warnLimited(
        keyNamespace(writes[0].key),
        'store-failed',
        DEGRADED_LOG_INTERVAL_MS,
        `cache batch write failed: ${(error as Error).message}`,
      );
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Refresh and the recompute lock

  /** SWR / XFetch: one background refresh per key per process, and one per key across processes (the lock). */
  private refreshInBackground<T>(
    key: string,
    loader: () => Promise<T | null>,
    opts: ResolvedOptions<T>,
    observedExp: number,
  ): void {
    const ns = keyNamespace(key);
    this.refreshes.track(key, async () => {
      let lock: LockAttempt = { state: 'unavailable' };
      try {
        lock = await this.tryLock(key, opts.timeoutMs);
        if (lock.state === 'contended') return; // another process is refreshing it
        if (lock.state === 'acquired') {
          const current = await this.peekFresh<T>(key, opts.timeoutMs);
          if (current && current.exp > observedExp) return; // already refreshed meanwhile
        }
        const loaded = await this.runLoader(ns, loader);
        await this.persistLoaded(
          key,
          loaded.value,
          loaded.delta,
          opts,
          this.l1Allowed(key, opts),
        );
      } catch (error) {
        this.count(ns, 'refresh_failed');
        this.log.warnLimited(
          ns,
          'refresh-failed',
          DEGRADED_LOG_INTERVAL_MS,
          `background refresh failed: ${(error as Error).message}`,
          key,
        );
      } finally {
        if (lock.state === 'acquired') await this.releaseLock(key, lock.token);
      }
    });
  }

  /** The recompute lock is an efficiency lock: if the store cannot say, work proceeds without it (fail open). */
  private async tryLock(key: string, timeoutMs: number): Promise<LockAttempt> {
    const token = randomUUID();
    try {
      const reply = await this.guard.run(
        () =>
          this.redis.client.set(
            recomputeLockKey(key),
            token,
            'PX',
            this.cfg.recomputeLockMs,
            'NX',
          ),
        timeoutMs,
      );
      return reply === 'OK'
        ? { state: 'acquired', token }
        : { state: 'contended' };
    } catch {
      return { state: 'unavailable' };
    }
  }

  private async releaseLock(key: string, token: string): Promise<void> {
    try {
      await this.guard.run(() =>
        runScript(
          this.redis.client,
          RELEASE_LOCK,
          [recomputeLockKey(key)],
          [token],
        ),
      );
    } catch {
      // the lock expires by itself
    }
  }

  /** A valid, fresh stored envelope for `key`, or undefined (also when the store cannot answer). */
  private async peekFresh<T>(
    key: string,
    timeoutMs: number,
  ): Promise<Envelope<T> | undefined> {
    try {
      const parsed = parseEnvelope<T>(
        await this.guard.run(() => this.redis.client.get(key), timeoutMs),
      );
      if (parsed.kind === 'ok' && this.clock.nowMs() < parsed.envelope.exp)
        return parsed.envelope;
    } catch {
      // treated as not there
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Plumbing

  private resolve<T>(options: GetOrLoadOptions<T>): ResolvedOptions<T> {
    return resolveGetOrLoadOptions(options, {
      timeoutMs: this.cfg.storeTimeoutMs,
      maxEntryBytes: this.cfg.maxEntryBytes,
    });
  }

  private l1Allowed<T>(key: string, opts: ResolvedOptions<T>): boolean {
    if (opts.l1 === 'never' || !this.broadcast.healthy) return false;
    return opts.l1 === 'always' || this.hotKeys.isHot(key);
  }

  private fillL1<T>(
    key: string,
    env: Envelope<T>,
    payload: string,
    opts: ResolvedOptions<T>,
    useL1: boolean,
  ): void {
    if (!useL1 || !this.broadcast.healthy) return;
    this.l1.set(key, env, payload, opts.l1TtlMs);
    this.syncL1Gauge();
  }

  private syncL1Gauge(): void {
    this.metrics.l1Entries.set(this.l1.size);
  }

  private onBroadcast(message: BroadcastMessage): void {
    if (message.kind === 'drop')
      for (const key of message.keys) this.l1.delete(key);
    else this.l1.dropIfOlder(message.key, message.version);
    this.syncL1Gauge();
  }

  private count(namespace: string, outcome: CacheOutcome): void {
    this.metrics.requests.add(1, { namespace, outcome });
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Shutdown: stop using L1, await running refreshes (bounded), close the subscription. */
  private async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.refreshes.drain(this.cfg.refreshShutdownWaitMs);
    this.broadcast.stop();
    this.l1.clear();
    this.syncL1Gauge();
  }
}
