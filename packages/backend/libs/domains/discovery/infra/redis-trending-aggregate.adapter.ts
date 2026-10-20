import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type {
  CorrectionMerge,
  MergeOutcome,
  RankedEntry,
  TrendingAggregateReader,
  TrendingAggregateWriter,
  WindowMerge,
} from '../domain/trending-ports';
import { TrendingSettings } from './trending-config';
import { aggregateKey, mergeKey, seenKey } from './trending-keys';
import { withBudget } from './with-budget';

/**
 * One window of one partition, all or nothing. KEYS = [merge record, aggregate…, seen key of each counted event…]; ARGV =
 * [ttl, covered offsets, aggregate count, then per aggregate: pair count and (member, score)…]. The seen keys make a copy of
 * a counted event that arrives after its window closed a no-op in the correction path (AS-29). The record is created with NX: when it already exists the merge was applied
 * before (a replay, or a second owner of the same partition) and nothing changes (S35 R-3, FR-019).
 */
const MERGE_WINDOW = `
local ttl = tonumber(ARGV[1])
if not redis.call('SET', KEYS[1], ARGV[2], 'NX', 'EX', ttl) then return 0 end
local aggregates = tonumber(ARGV[3])
local pos = 4
for k = 2, 1 + aggregates do
  local n = tonumber(ARGV[pos]); pos = pos + 1
  for i = 1, n do
    redis.call('ZINCRBY', KEYS[k], ARGV[pos + 1], ARGV[pos])
    pos = pos + 2
  end
  redis.call('EXPIRE', KEYS[k], ttl)
end
for k = 2 + aggregates, #KEYS do
  redis.call('SET', KEYS[k], '1', 'NX', 'EX', ttl)
end
return 1
`;

/**
 * Late events of one window. KEYS = [one seen key per event, aggregate…]; ARGV = [ttl, event count, then per event: member,
 * weight, number of aggregates and their 1-based positions in KEYS]. An event is claimed by its seen key in the same
 * atomic step that adds it, so redelivery changes nothing and a crash can neither lose nor double count it.
 */
const MERGE_CORRECTIONS = `
local ttl = tonumber(ARGV[1])
local m = tonumber(ARGV[2])
local pos = 3
local applied = 0
for i = 1, m do
  local member = ARGV[pos]
  local weight = ARGV[pos + 1]
  local nc = tonumber(ARGV[pos + 2])
  pos = pos + 3
  local fresh = redis.call('SET', KEYS[i], '1', 'NX', 'EX', ttl)
  for c = 1, nc do
    local idx = tonumber(ARGV[pos]); pos = pos + 1
    if fresh then
      redis.call('ZINCRBY', KEYS[idx], weight, member)
      redis.call('EXPIRE', KEYS[idx], ttl)
    end
  end
  if fresh then applied = applied + 1 end
end
return applied
`;

/**
 * The Redis side of the window aggregates: the atomic idempotent merge (write) and the union read over computed key names
 * (read). Every call runs under its own budget and is never retried here; retries live in one layer, the ingest service.
 */
@Injectable()
export class RedisTrendingAggregateAdapter
  implements TrendingAggregateReader, TrendingAggregateWriter
{
  constructor(
    private readonly redis: RedisService,
    private readonly settings: TrendingSettings,
  ) {}

  async mergeWindow(merge: WindowMerge): Promise<MergeOutcome> {
    const keys = [
      mergeKey(merge.partition, merge.windowStartMs),
      ...merge.categories.map((c) =>
        aggregateKey(c.category, merge.windowStartMs),
      ),
      ...(merge.eventIds ?? []).map(seenKey),
    ];
    const args: (string | number)[] = [
      this.settings.retentionSeconds,
      `${merge.firstOffset}-${merge.lastOffset}`,
      merge.categories.length,
    ];
    for (const c of merge.categories) {
      args.push(c.entries.length);
      for (const e of c.entries) args.push(e.productId, e.score);
    }
    const applied = await withBudget(
      this.redis.client.eval(MERGE_WINDOW, keys.length, ...keys, ...args),
      this.settings.mergeBudgetMs,
    );
    return Number(applied) === 1 ? 'applied' : 'replayed';
  }

  async mergeCorrections(merge: CorrectionMerge): Promise<{ applied: number }> {
    if (merge.events.length === 0) return { applied: 0 };
    const aggregates = [
      ...new Set(merge.events.flatMap((e) => e.categories)),
    ].map((category) => aggregateKey(category, merge.windowStartMs));
    const seen = merge.events.map((e) => seenKey(e.eventId));
    const keys = [...seen, ...aggregates];
    const args: (string | number)[] = [
      this.settings.retentionSeconds,
      merge.events.length,
    ];
    for (const e of merge.events) {
      args.push(e.productId, e.weight, e.categories.length);
      for (const category of e.categories)
        args.push(
          seen.length +
            aggregates.indexOf(aggregateKey(category, merge.windowStartMs)) +
            1,
        );
    }
    const applied = await withBudget(
      this.redis.client.eval(MERGE_CORRECTIONS, keys.length, ...keys, ...args),
      this.settings.mergeBudgetMs,
    );
    return { applied: Number(applied) };
  }

  async readUnion(
    category: string,
    windowStartsMs: number[],
    limit: number,
  ): Promise<RankedEntry[]> {
    const keys = windowStartsMs.map((start) => aggregateKey(category, start));
    const flat = (await withBudget(
      this.redis.client.call(
        'ZUNION',
        String(keys.length),
        ...keys,
        'AGGREGATE',
        'SUM',
        'WITHSCORES',
      ),
      this.settings.aggregateBudgetMs,
    )) as string[];
    const entries: RankedEntry[] = [];
    for (let i = 0; i < flat.length; i += 2)
      entries.push({
        productId: flat[i],
        score: Math.round(Number(flat[i + 1])),
      });
    entries.sort(
      (a, b) =>
        b.score - a.score ||
        (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0),
    );
    return entries.slice(0, limit);
  }
}
