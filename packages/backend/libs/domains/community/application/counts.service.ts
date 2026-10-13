import { Inject, Injectable } from '@nestjs/common';
import {
  CacheUnavailableError,
  COUNT_CACHE,
  COUNT_STORE,
  VOTE_STORE,
  type CountCache,
  type CountStore,
  type VoteStore,
} from '../domain/ports';
import type { VoteCounts } from '../domain/vote-transition';

/**
 * Displayed counts (S25 FR-024, FR-016). The vote store is the truth; Redis holds fast, expiring copies. A miss is
 * rebuilt from the records; if Redis is down a read recounts from the records and caches nothing. Comment and reply
 * counts come from durable counter tables behind the same kind of cache.
 */
@Injectable()
export class CountsService {
  constructor(
    @Inject(COUNT_CACHE) private readonly cache: CountCache,
    @Inject(COUNT_STORE) private readonly counters: CountStore,
    @Inject(VOTE_STORE) private readonly votes: VoteStore,
  ) {}

  async voteCounts(targetId: string): Promise<VoteCounts> {
    try {
      const hit = await this.cache.votes(targetId);
      if (hit) return hit;
      const counts = await this.votes.recount(targetId);
      await this.cache.setVotes(targetId, counts);
      return counts;
    } catch (error) {
      if (!(error instanceof CacheUnavailableError)) throw error;
      return this.votes.recount(targetId);
    }
  }

  async voteCountsMany(targetIds: string[]): Promise<Map<string, VoteCounts>> {
    const entries = await Promise.all(
      targetIds.map(async (id) => [id, await this.voteCounts(id)] as const),
    );
    return new Map(entries);
  }

  /** Exact counts straight from the records; also repairs the cached copy when Redis is up. */
  async recountVotes(targetId: string): Promise<VoteCounts> {
    const counts = await this.votes.recount(targetId);
    try {
      await this.cache.setVotes(targetId, counts);
    } catch (error) {
      if (!(error instanceof CacheUnavailableError)) throw error;
    }
    return counts;
  }

  async commentCount(postId: string): Promise<number> {
    try {
      const hit = await this.cache.commentCount(postId);
      if (hit !== null) return hit;
      const count = await this.counters.postComments(postId);
      await this.cache.setCommentCount(postId, count);
      return count;
    } catch (error) {
      if (!(error instanceof CacheUnavailableError)) throw error;
      return this.counters.postComments(postId);
    }
  }

  async commentCounts(postIds: string[]): Promise<Map<string, number>> {
    const entries = await Promise.all(
      postIds.map(async (id) => [id, await this.commentCount(id)] as const),
    );
    return new Map(entries);
  }

  async replyCounts(commentIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const missing: string[] = [];
    let cacheUp = true;
    for (const id of commentIds) {
      if (!cacheUp) {
        missing.push(id);
        continue;
      }
      try {
        const hit = await this.cache.replyCount(id);
        if (hit === null) missing.push(id);
        else out.set(id, hit);
      } catch (error) {
        if (!(error instanceof CacheUnavailableError)) throw error;
        cacheUp = false;
        missing.push(id);
      }
    }
    if (missing.length > 0) {
      const durable = await this.counters.replyCounts(missing);
      for (const id of missing) {
        const count = durable.get(id) ?? 0;
        out.set(id, count);
        if (cacheUp)
          await this.cache.setReplyCount(id, count).catch(() => undefined);
      }
    }
    return out;
  }

  /** Best-effort cache upkeep after a committed change: a cache failure never fails the write. */
  async bumpComments(
    postId: string,
    parentId: string | null,
    by: 1 | -1,
  ): Promise<void> {
    await this.counters.adjustPostComments(postId, by);
    if (parentId) await this.counters.adjustReplies(parentId, by);
    await this.cache.adjustCommentCount(postId, by).catch(swallowCache);
    if (parentId)
      await this.cache.adjustReplyCount(parentId, by).catch(swallowCache);
  }

  /** A new post or comment starts with zero counts in the cache, so its first votes never meet a miss. */
  async seedVotes(targetId: string): Promise<void> {
    await this.cache
      .setVotes(targetId, { ups: 0, downs: 0, wups: 0, wdowns: 0 })
      .catch(swallowCache);
  }
}

export function swallowCache(error: unknown): void {
  if (!(error instanceof CacheUnavailableError)) throw error;
}
