import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { VIEWER_ENTRY_TTL_MS } from '../domain/live-constants';
import { viewersKey } from '../domain/live-keys';
import type { ViewerCounts } from '../domain/live-ports';

const KEY_TTL_SEC = 60;

/**
 * Viewer counts per gateway instance: a hash `instance → <count>:<timestamp>`. The statistics publisher sums the entries
 * younger than 15 seconds, so a crashed instance's viewers drop out without anybody cleaning up (FR-031).
 */
@Injectable()
export class RedisViewerStore implements ViewerCounts {
  constructor(private readonly redis: RedisService) {}

  async report(
    streamId: string,
    instance: string,
    count: number,
    nowMs: number,
  ): Promise<void> {
    await this.redis.client
      .multi()
      .hset(viewersKey(streamId), instance, `${count}:${nowMs}`)
      .expire(viewersKey(streamId), KEY_TTL_SEC)
      .exec();
  }

  async clear(streamId: string, instance: string): Promise<void> {
    await this.redis.client.hdel(viewersKey(streamId), instance);
  }

  async total(streamId: string, nowMs: number): Promise<number> {
    const entries = await this.redis.client.hgetall(viewersKey(streamId));
    let viewers = 0;
    for (const entry of Object.values(entries)) {
      const [count, seenAt] = entry.split(':').map(Number);
      if (nowMs - seenAt < VIEWER_ENTRY_TTL_MS) viewers += count;
    }
    return viewers;
  }
}
