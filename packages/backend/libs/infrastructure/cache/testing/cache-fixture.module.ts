import { randomBytes, randomUUID } from 'node:crypto';
import { ApiConfigService } from '@app/common/config';
import '@app/common/config/api-config.service.mock';
import { FakeClock } from '@app/common/core/clock';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import type { RequestContext } from '@app/infrastructure/context/request-context.service';
import { CacheService } from '../cache.service';
import { CacheToolkitConfig } from '../cache.config';
import { RandomSource } from '../random-source';

/**
 * Test-only helpers for the cache toolkit's specs. This file imports no domain and no seeds (constitution X.5):
 * the toolkit is exercised against the real test Redis, a frozen clock and a scripted random source.
 */

export const testRedisUrl = (): string =>
  process.env.REDIS_URL ?? 'redis://localhost:6400/0';

/** `RedisService` and `CacheService` only ever call `config.get('redis_url')`. */
export const configFor = (url: string): ApiConfigService =>
  ({ get: () => url }) as unknown as ApiConfigService;

/** Draws from a queue, then from `fallback`. */
export class ScriptedRandom implements RandomSource {
  private readonly queue: number[];

  constructor(
    queue: number[] = [],
    private fallback = 0.5,
  ) {
    this.queue = [...queue];
  }

  static constant(value: number): ScriptedRandom {
    return new ScriptedRandom([], value);
  }

  push(...values: number[]): void {
    this.queue.push(...values);
  }

  setFallback(value: number): void {
    this.fallback = value;
  }

  next(): number {
    return this.queue.length > 0 ? this.queue.shift()! : this.fallback;
  }
}

export class Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/** The command connection refuses commands until connected (no offline queue); wait briefly, never fail. */
async function awaitReady(
  redis: RedisService,
  timeoutMs = 2_000,
): Promise<void> {
  const { client } = redis;
  if (client.status === 'ready') return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    client.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export interface CacheInstance {
  cache: CacheService;
  redis: RedisService;
  clock: FakeClock;
  random: RandomSource;
  /** Disconnects the instance's connections. */
  close(): Promise<void>;
}

export interface CacheInstanceOptions {
  clock?: FakeClock;
  random?: RandomSource;
  config?: Partial<CacheToolkitConfig>;
  /** Store URL of the command connection (point at a fault proxy). */
  clientUrl?: string;
  /** Store URL of the broadcast subscriber (point at a fault proxy). */
  subscriberUrl?: string;
  shutdown?: ShutdownRegistry;
  /** Makes log lines carry this request id, as an active request context would. */
  requestId?: string;
}

/**
 * "Another instance": a `CacheService` of its own (own L1, subscriber, in-flight table) over the same store.
 * The caller owns the clock; instances may share one.
 */
export async function createCacheInstance(
  options: CacheInstanceOptions = {},
): Promise<CacheInstance> {
  const clock = options.clock ?? new FakeClock();
  const random = options.random ?? ScriptedRandom.constant(0.5);
  const clientUrl = options.clientUrl ?? testRedisUrl();
  const redis = new RedisService(configFor(clientUrl));
  await awaitReady(redis);
  const cache = new CacheService(
    redis,
    configFor(options.subscriberUrl ?? testRedisUrl()),
    options.shutdown,
    clock,
    random,
    options.config,
    options.requestId
      ? ({ requestId: options.requestId } as unknown as RequestContext)
      : undefined,
  );
  await cache.onModuleInit();
  return {
    cache,
    redis,
    clock,
    random,
    close: async () => {
      await cache.onModuleDestroy();
      redis.client.disconnect();
    },
  };
}

/** A pass-through TCP proxy in front of the test Redis; flip `mode` to refuse or hang (VII.9). */
export async function startStoreProxy(): Promise<TcpFaultProxy> {
  const url = new URL(testRedisUrl());
  return TcpFaultProxy.start({
    host: url.hostname,
    port: Number(url.port || 6379),
  });
}

export const proxyUrl = (proxy: TcpFaultProxy): string =>
  `redis://127.0.0.1:${proxy.port}/0`;

/** A key in a namespace no other test uses, so metric deltas and leftovers never collide. */
export function uniqueKey(namespace = 'spec'): string {
  return `${namespace}:v1:${randomUUID()}`;
}

/**
 * A fresh namespace per call: the metric label of every key built from it. Random, not a counter: spec files run
 * in one process and each starts counting at zero, so a counter would repeat names across files and leave one
 * spec's leftovers in another's totals.
 */
export function uniqueNamespace(prefix = 'ns'): string {
  return `${prefix}${randomBytes(6).toString('hex')}`;
}

/** Current value of `cache_requests_total` for a namespace and outcome. */
export const outcomeCount = (namespace: string, outcome: string): number =>
  MetricsRegistry.value('cache_requests_total', { namespace, outcome }) ?? 0;

/**
 * Commands the store has executed so far (`INFO stats`). Differences between two readings, minus the one `INFO`
 * between them, count the store calls made in between: "zero store calls" is `delta === 0`.
 */
export async function storeCommands(redis: RedisService): Promise<number> {
  const info = await redis.client.info('stats');
  const match = /total_commands_processed:(\d+)/.exec(info);
  return Number(match?.[1] ?? 0);
}

/** Calls the store has served for one command (`INFO commandstats`), e.g. `unlink`, `del`. */
export async function commandCalls(
  redis: RedisService,
  command: string,
): Promise<number> {
  const info = await redis.client.info('commandstats');
  const match = new RegExp(`cmdstat_${command}:calls=(\\d+)`).exec(info);
  return Number(match?.[1] ?? 0);
}

/** The key's minimum accepted version as the store holds it (`<version>:<until>`), or null. */
export async function readMinimum(
  redis: RedisService,
  key: string,
): Promise<{ version: number; until: number } | null> {
  const raw = await redis.client.get(`{${key}}:min`);
  if (raw === null) return null;
  const [version, until] = raw.split(':').map(Number);
  return { version, until };
}

/** Runs `fn` and returns how many store commands it caused (this helper's own `INFO` excluded). */
export async function countStoreCalls(
  redis: RedisService,
  fn: () => Promise<unknown>,
): Promise<number> {
  const before = await storeCommands(redis);
  await fn();
  const after = await storeCommands(redis);
  return after - before - 1;
}
