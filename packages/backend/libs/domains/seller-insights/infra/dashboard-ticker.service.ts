import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  RealtimePublisher,
  RealtimeSubscriptions,
  RealtimeUnavailableError,
} from '@app/infrastructure/realtime';
import { insightsLog } from '../application/insights-log';
import { insightsMetrics } from '../application/seller-insights.metrics';
import { buildFrame } from '../domain/dashboard-frame';
import {
  LIVE_COUNTER_REPOSITORY,
  type LiveCounterRepository,
} from '../domain/ports';
import { Lease } from './lease';
import { INSIGHTS_REDIS } from './redis-board.repository';
import { LIVE_SUBSCRIBED_FALLBACK_KEY, liveLeaseKey } from './redis-keys';

export const LEASE_TTL_MS = 3_000;
const FALLBACK_TTL_MS = 10_000;
/** Shops handled at once inside one tick. */
const CONCURRENCY = 20;

/** `autoStart: false` lets a spec drive `tick(second)` itself. */
export const DASHBOARD_TICKER_OPTIONS = Symbol(
  'SELLER_INSIGHTS_TICKER_OPTIONS',
);
export interface DashboardTickerOptions {
  autoStart?: boolean;
  /** Names this instance in the leases; defaults to a random id. */
  instanceId?: string;
}

const shopIdOf = (topic: string): string => topic.split(':')[1];

/**
 * Once per second, for every shop that has at least one subscriber to `shop:{id}:live` and only for those, publishes one
 * `dashboard` frame without replay (S40 US5). Subscribed shops come from the realtime hub; one lease per shop splits them
 * across worker instances; ticks never overlap (an overrunning tick makes the next one skip); shutdown finishes the tick
 * in progress, publishes nothing afterwards and releases its leases.
 */
@Injectable()
export class DashboardTicker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(DashboardTicker.name);
  private readonly instanceId: string;
  private readonly lease: Lease;
  private readonly held = new Set<string>();
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<number>;
  private stopped = false;

  constructor(
    private readonly subscriptions: RealtimeSubscriptions,
    private readonly publisher: RealtimePublisher,
    @Inject(LIVE_COUNTER_REPOSITORY)
    private readonly counters: LiveCounterRepository,
    @Inject(INSIGHTS_REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional()
    @Inject(DASHBOARD_TICKER_OPTIONS)
    private readonly options: DashboardTickerOptions = {},
  ) {
    this.instanceId = options.instanceId ?? randomUUID();
    this.lease = new Lease(redis, this.instanceId, LEASE_TTL_MS);
  }

  onApplicationBootstrap(): void {
    if (this.options.autoStart === false) return;
    this.timer = setInterval(
      () => void this.tick().catch(() => undefined),
      1_000,
    );
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.inFlight?.catch(() => undefined);
    await Promise.all(
      [...this.held].map((shopId) =>
        this.lease.release(liveLeaseKey(shopId)).catch(() => undefined),
      ),
    );
    this.held.clear();
  }

  /** One tick for `second` (epoch seconds). Returns the number of frames published; 0 when skipped. */
  tick(second = Math.floor(this.clock.nowMs() / 1000)): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    if (this.inFlight) {
      insightsMetrics.tickSkipped();
      return Promise.resolve(0);
    }
    const run = this.run(second).finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = run;
    return run;
  }

  private async run(second: number): Promise<number> {
    const shops = await this.watchedShops();
    // a shop nobody watches any more gives its lease back, so another instance can take over when someone does
    for (const shopId of [...this.held])
      if (!shops.includes(shopId)) {
        this.held.delete(shopId);
        await this.lease.release(liveLeaseKey(shopId)).catch(() => undefined);
      }
    let published = 0;
    for (let i = 0; i < shops.length; i += CONCURRENCY) {
      const results = await Promise.all(
        shops
          .slice(i, i + CONCURRENCY)
          .map((shopId) => this.frameFor(shopId, second)),
      );
      published += results.filter(Boolean).length;
    }
    return published;
  }

  private async frameFor(shopId: string, second: number): Promise<boolean> {
    try {
      if (!(await this.lease.acquire(liveLeaseKey(shopId)))) return false;
      this.held.add(shopId);
      const frame = buildFrame(
        shopId,
        second,
        await this.counters.window(shopId, second),
      );
      await this.publisher.publish(`shop:${shopId}:live`, 'dashboard', frame, {
        replay: false,
      });
      insightsMetrics.frameComputed();
      return true;
    } catch (error) {
      insightsLog(
        this.logger,
        'warn',
        'dashboard_frame_failed',
        { traceId: `tick-${second}` },
        { shopId, error: (error as Error).name },
      );
      return false;
    }
  }

  /** The shops with a viewer; on a hub outage the list of the last 10 seconds is reused (S40 R-5). */
  private async watchedShops(): Promise<string[]> {
    try {
      const topics = await this.subscriptions.topicsWithSubscribers(
        'shop',
        'live',
      );
      const shops = topics.map(shopIdOf);
      await this.redis
        .set(
          LIVE_SUBSCRIBED_FALLBACK_KEY,
          JSON.stringify(shops),
          'PX',
          FALLBACK_TTL_MS,
        )
        .catch(() => undefined);
      return shops;
    } catch (error) {
      if (!(error instanceof RealtimeUnavailableError)) throw error;
      try {
        const cached = await this.redis.get(LIVE_SUBSCRIBED_FALLBACK_KEY);
        return cached ? (JSON.parse(cached) as string[]) : [];
      } catch {
        return [];
      }
    }
  }
}
