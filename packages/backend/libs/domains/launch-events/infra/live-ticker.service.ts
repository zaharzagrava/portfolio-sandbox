import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { hostname } from 'node:os';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { holdLease } from '@app/infrastructure/redis/lease';
import { RealtimePublisher } from '@app/infrastructure/realtime/realtime-publisher.service';
import { ACTIVE_STREAMS, REACTION_SHARDS, reactionKey, tickerLeaseKey, viewersKey } from './live-keys';

const TICK_MS = 1_000;
const LEASE_MS = 3_000;
const VIEWER_ENTRY_TTL_MS = 15_000;

/**
 * Once per second per live stream: sum the 8 reaction shards of the second
 * that just finished + the gateways' viewer counts → one `stats` event on
 * `stream:{id}`. A per-stream lease picks ONE worker instance per stream, so
 * N workers split the streams instead of all broadcasting duplicates.
 */
@Injectable()
export class LiveTicker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(LiveTicker.name);
  private readonly me = `${hostname()}-${process.pid}`;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly redis: RedisService,
    private readonly realtime: RealtimePublisher,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.tick().catch((e) => this.logger.warn(`live tick: ${e.message}`)), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async tick(now = Date.now()): Promise<number> {
    const streams = await this.redis.client.smembers(ACTIVE_STREAMS);
    let published = 0;
    for (const streamId of streams) {
      if (!(await holdLease(this.redis, tickerLeaseKey(streamId), this.me, LEASE_MS))) continue;
      const stats = await this.statsFor(streamId, Math.floor(now / 1000) - 1, now);
      await this.realtime.publish(`stream:${streamId}`, 'stats', stats, { replay: false });
      published++;
    }
    return published;
  }

  async statsFor(streamId: string, second: number, now: number) {
    const pipeline = this.redis.client.pipeline();
    for (let shard = 0; shard < REACTION_SHARDS; shard++) pipeline.hgetall(reactionKey(streamId, second, shard));
    pipeline.hgetall(viewersKey(streamId));
    const results = ((await pipeline.exec()) ?? []).map(([, value]) => (value ?? {}) as Record<string, string>);

    const reactions: Record<string, number> = {};
    for (const shard of results.slice(0, REACTION_SHARDS)) {
      for (const [emoji, count] of Object.entries(shard)) reactions[emoji] = (reactions[emoji] ?? 0) + Number(count);
    }
    let viewers = 0;
    for (const entry of Object.values(results[REACTION_SHARDS])) {
      const [count, seenAt] = entry.split(':').map(Number);
      if (now - seenAt < VIEWER_ENTRY_TTL_MS) viewers += count; // a crashed gateway's entry ages out
    }
    return { second, reactions, viewers };
  }
}
