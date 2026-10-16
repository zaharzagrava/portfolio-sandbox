import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ACTIVE_STREAMS } from '../../domain/live-keys';
import type { ActiveStreams } from '../../domain/live-ports';

/** The set of `LIVE` streams the statistics publisher walks. Derived: the reconcile job rebuilds it (FR-041). */
@Injectable()
export class RedisActiveStreams implements ActiveStreams {
  constructor(private readonly redis: RedisService) {}

  async add(streamId: string): Promise<void> {
    await this.redis.client.sadd(ACTIVE_STREAMS, streamId);
  }

  async remove(streamId: string): Promise<void> {
    await this.redis.client.srem(ACTIVE_STREAMS, streamId);
  }

  list(): Promise<string[]> {
    return this.redis.client.smembers(ACTIVE_STREAMS);
  }

  async replace(ids: string[]): Promise<{ added: number; removed: number }> {
    const wanted = new Set(ids);
    const current = new Set(await this.redis.client.smembers(ACTIVE_STREAMS));
    const toAdd = ids.filter((id) => !current.has(id));
    const toRemove = [...current].filter((id) => !wanted.has(id));
    const pipeline = this.redis.client.multi();
    if (toAdd.length > 0) pipeline.sadd(ACTIVE_STREAMS, ...toAdd);
    if (toRemove.length > 0) pipeline.srem(ACTIVE_STREAMS, ...toRemove);
    if (toAdd.length + toRemove.length > 0) await pipeline.exec();
    return { added: toAdd.length, removed: toRemove.length };
  }
}
