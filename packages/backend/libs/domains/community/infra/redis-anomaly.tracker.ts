import { Injectable } from '@nestjs/common';
import type { AnomalyTracker } from '../domain/ports';
import { RedisGuard } from './redis-guard';

const KEEP_SECONDS = 900;
const SENT_SECONDS = 3_600;

/** Zero-weight votes per target in a short-lived ZSET (`dsc:anom`) and a once-per-hour latch (`dsc:anomsent`). */
@Injectable()
export class RedisAnomalyTracker implements AnomalyTracker {
  constructor(private readonly guard: RedisGuard) {}

  async note(
    targetId: string,
    nowMs: number,
    windowSeconds: number,
  ): Promise<{ timestamps: number[]; lastSentAt: number | null }> {
    const key = `dsc:anom:{${targetId}}`;
    const sent = `dsc:anomsent:{${targetId}}`;
    return this.guard.run(async (c) => {
      // member = time + a counter so two votes in the same millisecond are two members
      const seq = await c.incr(`dsc:anomseq:{${targetId}}`);
      await c.expire(`dsc:anomseq:{${targetId}}`, KEEP_SECONDS);
      const results = await c
        .multi()
        .zadd(key, nowMs, `${nowMs}:${seq}`)
        .zremrangebyscore(key, '-inf', nowMs - windowSeconds * 1000)
        .expire(key, KEEP_SECONDS)
        .zrange(key, 0, -1, 'WITHSCORES')
        .get(sent)
        .exec();
      const flat = (results?.[3]?.[1] ?? []) as string[];
      const timestamps: number[] = [];
      for (let i = 1; i < flat.length; i += 2) timestamps.push(Number(flat[i]));
      const lastSent = results?.[4]?.[1] as string | null;
      return {
        timestamps,
        lastSentAt: lastSent === null ? null : Number(lastSent),
      };
    });
  }

  async markSent(targetId: string, nowMs: number): Promise<void> {
    await this.guard.run((c) =>
      c.set(`dsc:anomsent:{${targetId}}`, nowMs, 'EX', SENT_SECONDS),
    );
  }
}
