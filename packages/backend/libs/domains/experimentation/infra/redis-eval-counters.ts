import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { EvalCounterStore } from '../domain/ports';
import { EVAL_COUNT_TTL_SECONDS, evalCountKey } from './redis-keys';

/** Redis adapter of `EvalCounterStore`: one hash per UTC day (`flagKey → count`), expiring after 40 days. */
@Injectable()
export class RedisEvalCounters implements EvalCounterStore {
  constructor(private readonly redis: RedisService) {}

  async add(day: string, counts: Record<string, number>): Promise<void> {
    const entries = Object.entries(counts);
    if (entries.length === 0) return;
    const pipeline = this.redis.client.pipeline();
    for (const [key, n] of entries) pipeline.hincrby(evalCountKey(day), key, n);
    pipeline.expire(evalCountKey(day), EVAL_COUNT_TTL_SECONDS);
    const results = (await pipeline.exec()) ?? [];
    const failed = results.find(([error]) => error);
    if (failed)
      throw failed[0] instanceof Error
        ? failed[0]
        : new Error(String(failed[0]));
  }

  async totals(days: string[]): Promise<Record<string, number>> {
    const pipeline = this.redis.client.pipeline();
    for (const day of days) pipeline.hgetall(evalCountKey(day));
    const totals: Record<string, number> = {};
    for (const [error, counts] of (await pipeline.exec()) ?? []) {
      if (error) throw error;
      for (const [key, n] of Object.entries(
        (counts ?? {}) as Record<string, string>,
      ))
        totals[key] = (totals[key] ?? 0) + Number(n);
    }
    return totals;
  }
}
