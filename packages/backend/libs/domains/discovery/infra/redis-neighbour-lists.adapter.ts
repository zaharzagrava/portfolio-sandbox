import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type {
  NeighbourListReader,
  NeighbourListWriter,
  PublishedList,
  StoredEntry,
} from '../domain/recommendation-ports';
import {
  BOUGHT_TOGETHER_PATTERN,
  boughtTogetherKey,
  boughtTogetherStagingKey,
  buildMarkerKey,
  productIdOfKey,
} from './recommendation-keys';
import { RecommendationsSettings } from './recommendations-config';
import { withBudget } from './with-budget';

/** A damaged list may hold more than the 20 a build writes; the read is bounded all the same. */
const READ_LIMIT = 100;
const MARKER_TTL_SECONDS = 7_200;
const SCAN_COUNT = 500;

const entries = (flat: string[] | undefined): StoredEntry[] => {
  const out: StoredEntry[] = [];
  for (let i = 0; i + 1 < (flat?.length ?? 0); i += 2)
    out.push({ member: flat![i], score: Number(flat![i + 1]) });
  return out;
};

/**
 * Neighbour lists over Redis sorted sets (`rec:bought:{productId}`, member = neighbour, score = cosine). Reads are budgeted
 * and never retried; a list is replaced by writing a staging key and `RENAME`-ing it over the live one, so a reader sees
 * the complete old or the complete new list (S34 FR-021, R-7).
 */
@Injectable()
export class RedisNeighbourListsAdapter
  implements NeighbourListReader, NeighbourListWriter
{
  constructor(
    private readonly redis: RedisService,
    private readonly settings: RecommendationsSettings,
  ) {}

  async read(productId: string): Promise<StoredEntry[]> {
    const flat = await withBudget(
      this.redis.client.zrevrange(
        boughtTogetherKey(productId),
        0,
        READ_LIMIT - 1,
        'WITHSCORES',
      ),
      this.settings.storeBudgetMs,
    );
    return entries(flat);
  }

  async readMany(productIds: string[]): Promise<Map<string, StoredEntry[]>> {
    const result = new Map<string, StoredEntry[]>();
    if (productIds.length === 0) return result;
    const pipeline = this.redis.client.pipeline();
    for (const productId of productIds)
      pipeline.zrevrange(
        boughtTogetherKey(productId),
        0,
        READ_LIMIT - 1,
        'WITHSCORES',
      );
    const replies = await withBudget(
      pipeline.exec(),
      this.settings.storeBudgetMs,
    );
    productIds.forEach((productId, i) => {
      const [error, flat] = replies?.[i] ?? [new Error('no reply'), null];
      if (error) throw error;
      result.set(productId, entries(flat as string[]));
    });
    return result;
  }

  async publish(runId: string, lists: PublishedList[]): Promise<void> {
    if (lists.length === 0) return;
    const marker = buildMarkerKey(runId);
    const pipeline = this.redis.client.pipeline();
    for (const { productId, entries: list } of lists) {
      const staging = boughtTogetherStagingKey(productId);
      pipeline.del(staging);
      pipeline.zadd(staging, ...list.flatMap((e) => [e.score, e.member]));
      pipeline.expire(staging, this.settings.ttlSeconds);
      pipeline.rename(staging, boughtTogetherKey(productId));
      pipeline.sadd(marker, productId);
    }
    pipeline.expire(marker, MARKER_TTL_SECONDS);
    for (const [error] of (await pipeline.exec()) ?? []) if (error) throw error;
  }

  async removeUnpublished(runId: string): Promise<number> {
    const marker = buildMarkerKey(runId);
    let removed = 0;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.client.scan(
        cursor,
        'MATCH',
        BOUGHT_TOGETHER_PATTERN,
        'COUNT',
        SCAN_COUNT,
      );
      cursor = next;
      const live = keys
        .map((key) => ({ key, productId: productIdOfKey(key) }))
        .filter((k): k is { key: string; productId: string } => !!k.productId);
      if (live.length === 0) continue;
      const published = await this.redis.client.smismember(
        marker,
        ...live.map((k) => k.productId),
      );
      const doomed = live
        .filter((_, i) => published[i] === 0)
        .map((k) => k.key);
      if (doomed.length > 0) removed += await this.redis.client.del(...doomed);
    } while (cursor !== '0');
    return removed;
  }

  async closeRun(runId: string): Promise<void> {
    await this.redis.client.del(buildMarkerKey(runId));
  }
}
