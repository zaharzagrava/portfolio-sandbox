import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { REACTION_SHARDS, type Reaction } from '../../domain/live-constants';
import { reactionKey } from '../../domain/live-keys';
import type { ReactionCounters } from '../../domain/live-ports';

const COUNTER_TTL_SEC = 10;

/**
 * Per-second reaction counters on a random one of 8 shards (200k HINCRBY/s must not hit one key). The ticker sums the
 * shards of the second that just ended; a late increment lands in a key nobody reads again and expires.
 */
@Injectable()
export class RedisReactionCounters implements ReactionCounters {
  constructor(private readonly redis: RedisService) {}

  async add(
    streamId: string,
    second: number,
    reactions: Partial<Record<Reaction, number>>,
  ): Promise<void> {
    const key = reactionKey(
      streamId,
      second,
      Math.floor(Math.random() * REACTION_SHARDS),
    );
    const pipeline = this.redis.client.multi();
    for (const [emoji, count] of Object.entries(reactions))
      pipeline.hincrby(key, emoji, count as number);
    pipeline.expire(key, COUNTER_TTL_SEC);
    await pipeline.exec();
  }

  async totals(
    streamId: string,
    second: number,
  ): Promise<Record<string, number>> {
    const pipeline = this.redis.client.pipeline();
    for (let shard = 0; shard < REACTION_SHARDS; shard++)
      pipeline.hgetall(reactionKey(streamId, second, shard));
    const results = (await pipeline.exec()) ?? [];
    const totals: Record<string, number> = {};
    for (const [error, value] of results) {
      if (error) throw error;
      for (const [emoji, count] of Object.entries(
        (value ?? {}) as Record<string, string>,
      ))
        totals[emoji] = (totals[emoji] ?? 0) + Number(count);
    }
    return totals;
  }
}
