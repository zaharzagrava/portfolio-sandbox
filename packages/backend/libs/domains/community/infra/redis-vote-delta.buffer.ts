import { Injectable } from '@nestjs/common';
import { WriteBehindCounter } from '@app/infrastructure/cache/write-behind-counter';
import type { RedisService } from '@app/infrastructure/redis/redis.service';
import { CacheUnavailableError } from '../domain/ports';
import type { VoteCountDelta, VoteDeltaBuffer } from '../domain/ports';
import { RedisGuard } from './redis-guard';

type Field = keyof VoteCountDelta;
const FIELDS: Field[] = ['ups', 'downs', 'wups', 'wdowns'];

/**
 * The write-behind buffer of the durable vote aggregate (`vote_counts`, S25 C4): O(1) increments in Redis, drained by
 * the flush job into one counter update per target. Members are `<targetId>|<field>`.
 */
@Injectable()
export class RedisVoteDeltaBuffer implements VoteDeltaBuffer {
  private readonly counter: WriteBehindCounter;

  constructor(guard: RedisGuard) {
    // The counter only needs `.client`; it is the same faultable client every discussions cache uses.
    this.counter = new WriteBehindCounter(
      { client: guard.client } as RedisService,
      'discussions-votes',
    );
  }

  async add(targetId: string, d: VoteCountDelta): Promise<void> {
    try {
      for (const field of FIELDS)
        if (d[field] !== 0)
          await this.counter.increment(`${targetId}|${field}`, d[field]);
    } catch {
      throw new CacheUnavailableError();
    }
  }

  async drain(): Promise<Map<string, VoteCountDelta>> {
    const drained = await this.counter.drain();
    const byTarget = new Map<string, VoteCountDelta>();
    for (const [member, by] of drained) {
      const [targetId, field] = member.split('|') as [string, Field];
      const entry = byTarget.get(targetId) ?? {
        ups: 0,
        downs: 0,
        wups: 0,
        wdowns: 0,
      };
      entry[field] += by;
      byTarget.set(targetId, entry);
    }
    return byTarget;
  }

  async restore(deltas: Map<string, VoteCountDelta>): Promise<void> {
    const flat = new Map<string, number>();
    for (const [targetId, d] of deltas)
      for (const field of FIELDS)
        if (d[field] !== 0) flat.set(`${targetId}|${field}`, d[field]);
    await this.counter.restore(flat);
  }
}
