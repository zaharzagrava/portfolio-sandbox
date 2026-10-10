import { randomUUID } from 'node:crypto';
import { ApiConfigService } from '@app/common/config';
import '@app/common/config/api-config.service.mock';
import { FakeClock } from '@app/common/core/clock';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { PolicyTable } from '../policy';
import { PolicyRegistry } from '../policy-registry';
import { RateLimitConfig } from '../rate-limit.config';
import { RateLimitMetrics } from '../rate-limit.metrics';
import { RateLimiterService } from '../rate-limiter.service';
import { ScriptLoader } from '../script-loader';
import { StoreGuard } from '../store-guard';
import { ManualTimeSource, StoreTimeSource, TimeSource } from '../time-source';
import { probePolicies } from './probe-policies';

export const testRedisUrl = (): string =>
  process.env.REDIS_URL ?? 'redis://localhost:6400/0';

/** `RedisService` only ever calls `config.get('redis_url')`. */
export const configFor = (url: string): ApiConfigService =>
  ({ get: () => url }) as unknown as ApiConfigService;

/** Store time (ms) the specs start from: far from the real clock, so a leftover real-time key cannot interfere. */
export const T0 = 1_800_000_000_000;

export interface LimiterOptions {
  policies?: PolicyTable[];
  /** `false` leaves out `probePolicies` (a spec declaring the same names itself). */
  probe?: boolean;
  /** Defaults to a `ManualTimeSource` starting at `T0`; pass `'store'` for the store's own clock. */
  time?: TimeSource | 'store';
  clientUrl?: string;
  config?: Partial<RateLimitConfig>;
  clock?: FakeClock;
}

export interface LimiterInstance {
  limiter: RateLimiterService;
  registry: PolicyRegistry;
  redis: RedisService;
  time: TimeSource;
  manualTime: ManualTimeSource;
  clock: FakeClock;
  guard: StoreGuard;
  config: RateLimitConfig;
  metrics: RateLimitMetrics;
  scripts: ScriptLoader;
  close(): Promise<void>;
}

/** The command connection refuses commands until connected (no offline queue); wait briefly, never fail. */
export async function awaitReady(redis: RedisService, timeoutMs = 2_000) {
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

/**
 * "One instance" of the limiter (own breaker, lease, fallback and script cache) over the real test Redis. Several
 * calls give several instances sharing one store, as a fleet does.
 */
export async function createLimiter(
  options: LimiterOptions = {},
): Promise<LimiterInstance> {
  const redis = new RedisService(
    configFor(options.clientUrl ?? testRedisUrl()),
  );
  await awaitReady(redis);
  const config = Object.assign(new RateLimitConfig(), options.config);
  const manualTime = new ManualTimeSource(T0);
  const time =
    options.time === 'store'
      ? new StoreTimeSource()
      : (options.time ?? manualTime);
  const clock = options.clock ?? new FakeClock();
  const registry = new PolicyRegistry();
  if (options.probe !== false) registry.register(probePolicies);
  for (const table of options.policies ?? []) registry.register(table);
  const metrics = new RateLimitMetrics();
  const guard = new StoreGuard(config, metrics, clock);
  const scripts = new ScriptLoader(redis);
  const limiter = new RateLimiterService(
    registry,
    scripts,
    guard,
    time,
    config,
    metrics,
    redis,
    clock,
  );
  return {
    limiter,
    registry,
    redis,
    time,
    manualTime,
    clock,
    guard,
    config,
    metrics,
    scripts,
    close() {
      redis.client.disconnect();
      return Promise.resolve();
    },
  };
}

/** Script calls the store has served so far (`INFO commandstats`): how specs count store round trips without a mock. */
export async function evalCalls(redis: RedisService): Promise<number> {
  const info = await redis.client.info('commandstats');
  const match = /cmdstat_evalsha:calls=(\d+)/.exec(info);
  return match ? Number(match[1]) : 0;
}

export { proxyUrl, startStoreProxy } from '../testing/fault-proxy';

/** A subject no other test uses. */
export const uniqueSubject = (kind = 'user'): string =>
  `${kind}:${randomUUID()}`;

/** Keys matching `pattern`, found with SCAN (the lib itself never scans; specs may). */
export async function scanKeys(
  redis: RedisService,
  pattern: string,
): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.client.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      1000,
    );
    cursor = next;
    found.push(...batch);
  } while (cursor !== '0');
  return found;
}

/** Keys the limiter stored for one subject, with their remaining lifetime in ms. */
export async function storedItems(
  redis: RedisService,
  subject: string,
): Promise<{ key: string; ttlMs: number }[]> {
  const keys = await redis.client.keys(`rl:{*|${subject}}:*`);
  return Promise.all(
    keys.map(async (key) => ({ key, ttlMs: await redis.client.pttl(key) })),
  );
}
