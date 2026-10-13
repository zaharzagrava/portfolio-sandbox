import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import type { CountCache } from '../domain/ports';
import type { VoteCounts } from '../domain/vote-transition';
import { COUNT_APPLY, COUNTER_ADJUST } from './rank-scripts';
import { RedisGuard } from './redis-guard';

const voteKey = (id: string) => `dsc:cnt:{${id}}`;
const commentKey = (postId: string) => `dsc:ccnt:{${postId}}`;
const replyKey = (commentId: string) => `dsc:rcnt:{${commentId}}`;

const asCounts = (flat: unknown): VoteCounts => {
  const [ups, downs, wups, wdowns] = (flat as Array<number | string>).map(
    Number,
  );
  return { ups, downs, wups, wdowns };
};

/** Fast derived counts: every key expires (`discussions_count_ttl_seconds`), a miss is rebuilt from the durable store. */
@Injectable()
export class RedisCountCache implements CountCache {
  constructor(
    private readonly guard: RedisGuard,
    private readonly config: ApiConfigService,
  ) {}

  private get ttl(): number {
    return this.config.get('discussions_count_ttl_seconds');
  }

  async votes(targetId: string): Promise<VoteCounts | null> {
    const raw = await this.guard.run((c) =>
      c.hmget(voteKey(targetId), 'ups', 'downs', 'wups', 'wdowns'),
    );
    return raw[0] === null ? null : asCounts(raw);
  }

  async setVotes(targetId: string, counts: VoteCounts): Promise<void> {
    await this.guard.run((c) =>
      c
        .multi()
        .hset(voteKey(targetId), {
          ups: counts.ups,
          downs: counts.downs,
          wups: counts.wups,
          wdowns: counts.wdowns,
        })
        .expire(voteKey(targetId), this.ttl)
        .exec(),
    );
  }

  async applyVoteDelta(
    targetId: string,
    d: { dUps: number; dDowns: number; dWups: number; dWdowns: number },
  ): Promise<VoteCounts | null> {
    const result = await this.guard.run((c) =>
      c.eval(
        COUNT_APPLY,
        1,
        voteKey(targetId),
        d.dUps,
        d.dDowns,
        d.dWups,
        d.dWdowns,
        this.ttl,
      ),
    );
    return result ? asCounts(result) : null;
  }

  private async getNumber(key: string): Promise<number | null> {
    const raw = await this.guard.run((c) => c.get(key));
    return raw === null ? null : Number(raw);
  }

  private async setNumber(key: string, value: number): Promise<void> {
    await this.guard.run((c) => c.set(key, value, 'EX', this.ttl));
  }

  private async adjust(key: string, by: number): Promise<void> {
    await this.guard.run((c) => c.eval(COUNTER_ADJUST, 1, key, by, this.ttl));
  }

  commentCount(postId: string): Promise<number | null> {
    return this.getNumber(commentKey(postId));
  }
  setCommentCount(postId: string, count: number): Promise<void> {
    return this.setNumber(commentKey(postId), count);
  }
  adjustCommentCount(postId: string, by: 1 | -1): Promise<void> {
    return this.adjust(commentKey(postId), by);
  }
  replyCount(commentId: string): Promise<number | null> {
    return this.getNumber(replyKey(commentId));
  }
  setReplyCount(commentId: string, count: number): Promise<void> {
    return this.setNumber(replyKey(commentId), count);
  }
  adjustReplyCount(commentId: string, by: 1 | -1): Promise<void> {
    return this.adjust(replyKey(commentId), by);
  }
}
