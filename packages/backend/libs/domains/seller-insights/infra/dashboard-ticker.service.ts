import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { hostname } from 'node:os';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { holdLease } from '@app/infrastructure/redis/lease';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import { channelName } from '@app/infrastructure/realtime';
import { DASH_ACTIVE, dashBucketKey } from './shop-live.projector';

const WINDOW_SEC = 60;

export interface LiveDashboard {
  at: number;
  last60s: {
    checkouts: number;
    orders: number;
    units: number;
    revenue: number;
  };
  ordersPerSecond: number[];
  checkoutConversion: number | null;
}

/**
 * Every second: for shops with recent activity AND at least one dashboard
 * subscriber (PUBSUB NUMSUB - no viewers, no work), sum the last 60 one-second
 * buckets and push to `shop:{id}:live`. Per-shop leases split shops across
 * worker instances.
 */
@Injectable()
export class DashboardTicker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(DashboardTicker.name);
  private readonly me = `${hostname()}-${process.pid}`;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly redis: RedisService,
    private readonly realtime: RealtimePublisher,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(
      () =>
        void this.tick().catch((e) =>
          this.logger.warn(`dashboard tick: ${e.message}`),
        ),
      1_000,
    );
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async tick(now = Date.now()): Promise<number> {
    const nowSec = Math.floor(now / 1000);
    await this.redis.client.zremrangebyscore(
      DASH_ACTIVE,
      '-inf',
      nowSec - WINDOW_SEC * 2,
    );
    const shops = await this.redis.client.zrangebyscore(
      DASH_ACTIVE,
      nowSec - WINDOW_SEC,
      '+inf',
    );
    let published = 0;
    for (const shopId of shops) {
      const topic = `shop:${shopId}:live` as const;
      const [, watchers] = (await this.redis.client.pubsub(
        'NUMSUB',
        channelName(topic),
      )) as [string, number];
      if (!Number(watchers)) continue;
      if (
        !(await holdLease(
          this.redis,
          `dash:{${shopId}}:ticker`,
          this.me,
          3_000,
        ))
      )
        continue;
      await this.realtime.publish(
        topic,
        'dashboard',
        await this.compute(shopId, nowSec),
        { replay: false },
      );
      published++;
    }
    return published;
  }

  async compute(shopId: string, nowSec: number): Promise<LiveDashboard> {
    const pipeline = this.redis.client.pipeline();
    for (let s = nowSec - WINDOW_SEC + 1; s <= nowSec; s++)
      pipeline.hgetall(dashBucketKey(shopId, s));
    const buckets = ((await pipeline.exec()) ?? []).map(
      ([, v]) => (v ?? {}) as Record<string, string>,
    );
    const totals = { checkouts: 0, orders: 0, units: 0, revenue: 0 };
    const ordersPerSecond: number[] = [];
    for (const b of buckets) {
      for (const k of Object.keys(totals) as (keyof typeof totals)[])
        totals[k] += Number(b[k] ?? 0);
      ordersPerSecond.push(Number(b.orders ?? 0));
    }
    return {
      at: nowSec,
      last60s: totals,
      ordersPerSecond,
      checkoutConversion: totals.checkouts
        ? Math.round((totals.orders / totals.checkouts) * 1000) / 1000
        : null,
    };
  }
}
