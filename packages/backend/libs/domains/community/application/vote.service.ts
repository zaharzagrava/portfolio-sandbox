import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { types } from 'cassandra-driver';
import { CassandraService } from '@app/infrastructure/cassandra/cassandra.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { WriteBehindCounter } from '@app/infrastructure/cache/write-behind-counter';
import { hotScore, wilsonLowerBound } from '../domain/ranking';
import { boardKey, scoreKey } from './discussion.service';

export type VoteValue = -1 | 0 | 1;
export const VOTE_DELTAS = 'vote-deltas';

/**
 * One vote per user per target, changeable (lesson 10/05 #11):
 *  - the previous vote is read and the new one written under a short
 *    per-(user, target) Redis lock, so a double click can't apply a delta twice,
 *  - the DELTA (+1, -1, ±2 when flipping) goes to a Redis score hash (live,
 *    atomic HINCRBY - no hot counter row) and to a write-behind buffer flushed
 *    to Scylla counters every few seconds,
 *  - hot/top/best rankings are recomputed from the live score.
 */
@Injectable()
export class VoteService {
  private readonly deltas: WriteBehindCounter;

  constructor(
    private readonly cassandra: CassandraService,
    private readonly redis: RedisService,
  ) {
    this.deltas = new WriteBehindCounter(redis, VOTE_DELTAS);
  }

  async vote(
    userId: string,
    targetType: 'post' | 'comment',
    targetId: string,
    value: VoteValue,
  ) {
    const lockKey = `vote-lock:${userId}:${targetId}`;
    if ((await this.redis.client.set(lockKey, '1', 'PX', 3_000, 'NX')) !== 'OK')
      throw new ConflictException('Vote in progress');
    try {
      const context = await this.context(targetType, targetId);
      const previous =
        (
          await this.cassandra.execute(
            'SELECT value FROM votes_by_user WHERE user_id = ? AND target_id = ?',
            [userId, targetId],
          )
        ).rows[0]?.value ?? 0;
      if (previous === value) return this.score(targetId);

      if (value === 0) {
        await Promise.all([
          this.cassandra.execute(
            'DELETE FROM votes_by_user WHERE user_id = ? AND target_id = ?',
            [userId, targetId],
          ),
          this.cassandra.execute(
            'DELETE FROM votes_by_target WHERE target_id = ? AND user_id = ?',
            [targetId, userId],
          ),
        ]);
      } else {
        await Promise.all([
          this.cassandra.execute(
            'INSERT INTO votes_by_user (user_id, target_id, value) VALUES (?, ?, ?)',
            [userId, targetId, value],
          ),
          this.cassandra.execute(
            'INSERT INTO votes_by_target (target_id, user_id, value) VALUES (?, ?, ?)',
            [targetId, userId, value],
          ),
        ]);
      }

      const upsDelta = (value === 1 ? 1 : 0) - (previous === 1 ? 1 : 0);
      const downsDelta = (value === -1 ? 1 : 0) - (previous === -1 ? 1 : 0);
      const [ups, downs] = await this.applyDelta(
        targetId,
        upsDelta,
        downsDelta,
      );
      await this.rerank(targetType, targetId, context, ups, downs);
      return { ups, downs, myVote: value };
    } finally {
      await this.redis.client.del(lockKey);
    }
  }

  async score(targetId: string) {
    const [ups, downs] = await this.redis.client.hmget(
      scoreKey(targetId),
      'ups',
      'downs',
    );
    return { ups: Number(ups ?? 0), downs: Number(downs ?? 0) };
  }

  /** Drains the write-behind buffer into Scylla counters (one UPDATE per target per flush). */
  async flushToCounters(): Promise<number> {
    const drained = await this.deltas.drain();
    const byTarget = new Map<string, { ups: number; downs: number }>();
    for (const [member, delta] of drained) {
      const [targetId, field] = member.split('|') as [string, 'ups' | 'downs'];
      const entry = byTarget.get(targetId) ?? { ups: 0, downs: 0 };
      entry[field] += delta;
      byTarget.set(targetId, entry);
    }
    try {
      for (const [targetId, d] of byTarget) {
        await this.cassandra.client.execute(
          'UPDATE vote_counts SET ups = ups + ?, downs = downs + ? WHERE target_id = ?',
          [types_long(d.ups), types_long(d.downs), targetId],
          {
            prepare: true,
            isIdempotent: false, // counter updates must never be retried by the driver
          },
        );
      }
    } catch (error) {
      await this.deltas.restore(drained);
      throw error;
    }
    return byTarget.size;
  }

  /**
   * Exact recount from `votes_by_target` (counters are at-least-once and can
   * drift by a retried batch) - repairs the live Redis score that ranking reads.
   */
  async recount(targetId: string): Promise<{ ups: number; downs: number }> {
    let ups = 0;
    let downs = 0;
    let pageState: string | undefined;
    do {
      const page = await this.cassandra.execute(
        'SELECT value FROM votes_by_target WHERE target_id = ?',
        [targetId],
        { fetchSize: 5_000, pageState },
      );
      for (const row of page.rows) row.value === 1 ? ups++ : downs++;
      pageState = page.pageState ?? undefined;
    } while (pageState);
    await this.redis.client.hset(
      scoreKey(targetId),
      'ups',
      ups,
      'downs',
      downs,
    );
    return { ups, downs };
  }

  private async applyDelta(
    targetId: string,
    upsDelta: number,
    downsDelta: number,
  ): Promise<[number, number]> {
    const tx = this.redis.client
      .multi()
      .hincrby(scoreKey(targetId), 'ups', upsDelta)
      .hincrby(scoreKey(targetId), 'downs', downsDelta);
    const results = await tx.exec();
    if (upsDelta) await this.deltas.increment(`${targetId}|ups`, upsDelta);
    if (downsDelta)
      await this.deltas.increment(`${targetId}|downs`, downsDelta);
    return [Number(results![0][1]), Number(results![1][1])];
  }

  private async context(
    targetType: 'post' | 'comment',
    targetId: string,
  ): Promise<{ boardId?: string; createdAt?: number; postId?: string }> {
    if (targetType === 'post') {
      const [boardId, createdAt] = await this.redis.client.hmget(
        `post-meta:${targetId}`,
        'boardId',
        'createdAt',
      );
      if (!boardId) {
        const row = (
          await this.cassandra.execute(
            'SELECT board_id, created_at FROM posts WHERE post_id = ?',
            [targetId],
          )
        ).rows[0];
        if (!row) throw new NotFoundException('Post not found');
        return { boardId: row.board_id, createdAt: row.created_at.getTime() };
      }
      return { boardId, createdAt: Number(createdAt) };
    }
    const loc = (
      await this.cassandra.execute(
        'SELECT post_id FROM comment_locator WHERE comment_id = ?',
        [targetId],
      )
    ).rows[0];
    if (!loc) throw new NotFoundException('Comment not found');
    return { postId: loc.post_id.toString() };
  }

  private async rerank(
    targetType: 'post' | 'comment',
    targetId: string,
    ctx: { boardId?: string; createdAt?: number; postId?: string },
    ups: number,
    downs: number,
  ) {
    if (targetType === 'post') {
      await this.redis.client
        .multi()
        .zadd(
          boardKey(ctx.boardId!, 'hot'),
          hotScore(ups, downs, new Date(ctx.createdAt!)),
          targetId,
        )
        .zadd(boardKey(ctx.boardId!, 'top'), ups - downs, targetId)
        .exec();
    } else {
      // Only top-level comments live in the "best" set (XX: never add replies).
      await this.redis.client.zadd(
        `post:{${ctx.postId}}:best`,
        'XX',
        wilsonLowerBound(ups, downs),
        targetId,
      );
    }
  }
}

/** Counter columns are bigint; the driver needs Long for them. */
function types_long(n: number) {
  return types.Long.fromNumber(n);
}
