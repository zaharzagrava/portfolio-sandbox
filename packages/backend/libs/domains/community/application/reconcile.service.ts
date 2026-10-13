import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { discussionDriftCounter } from '../domain/discussions-metrics';
import { dayOf } from '../domain/months';
import {
  CacheUnavailableError,
  COMMENT_STORE,
  COUNT_CACHE,
  COUNT_STORE,
  POST_STORE,
  VOTE_DELTA_BUFFER,
  VOTE_STORE,
  type CommentStore,
  type CountCache,
  type CountStore,
  type PostStore,
  type VoteDeltaBuffer,
  type VoteStore,
} from '../domain/ports';
import type { VoteCounts } from '../domain/vote-transition';
import { RankingService } from './ranking.service';

const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

const WORKLIST_LIMIT = 5_000;
const DAY_MS = 86_400_000;

/**
 * Derived state is rebuildable (S25 C4, C5, FR-024): the vote records and comment rows are the truth. Reconciliation
 * walks the targets voted and the posts commented in the last two days, recounts them exactly, repairs the cached and
 * the durable counters and recomputes the ranking entries (AS-50). Running it twice changes nothing the second time.
 */
@Injectable()
export class ReconcileService {
  private readonly logger = new Logger(ReconcileService.name);

  constructor(
    @Inject(VOTE_STORE) private readonly votes: VoteStore,
    @Inject(VOTE_DELTA_BUFFER) private readonly buffer: VoteDeltaBuffer,
    @Inject(COUNT_STORE) private readonly counters: CountStore,
    @Inject(COUNT_CACHE) private readonly cache: CountCache,
    @Inject(POST_STORE) private readonly posts: PostStore,
    @Inject(COMMENT_STORE) private readonly comments: CommentStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly ranking: RankingService,
  ) {}

  /** Drains the write-behind buffer into the durable aggregate (one counter update per target per flush). */
  async flushVotes(): Promise<number> {
    const drained = await this.buffer.drain();
    const day = dayOf(this.clock.now());
    try {
      for (const [targetId, d] of drained) {
        await this.counters.addVoteDeltas(targetId, d);
        await this.counters.markVoted(targetId, day);
      }
    } catch (error) {
      await this.buffer.restore(drained);
      throw error;
    }
    return drained.size;
  }

  /** One full pass: flush, then recount the recent targets and posts. */
  async reconcile(): Promise<{ targets: number; repaired: number }> {
    await this.flushVotes();
    const now = this.clock.now();
    const days = [dayOf(now), dayOf(new Date(now.getTime() - DAY_MS))];
    let targets = 0;
    let repaired = 0;
    for (const day of days) {
      for (const targetId of await this.counters.votedTargets(
        day,
        WORKLIST_LIMIT,
      )) {
        targets++;
        repaired += await this.recountTarget(targetId);
      }
      for (const postId of await this.counters.commentedPosts(
        day,
        WORKLIST_LIMIT,
      ))
        repaired += await this.recountComments(postId);
    }
    return { targets, repaired };
  }

  /** Exact recount of one target; returns how many of its counters had drifted. */
  async recountTarget(targetId: string): Promise<number> {
    const exact = await this.votes.recount(targetId);
    let drifted = 0;
    const found: string[] = [];
    try {
      const cached = await this.cache.votes(targetId);
      if (cached && this.differs(cached, exact)) {
        drifted++;
        discussionDriftCounter.add(1, { kind: 'cache' });
        found.push(
          `live ups ${signed(cached.ups - exact.ups)} downs ${signed(cached.downs - exact.downs)}`,
        );
        await this.cache.setVotes(targetId, exact);
      }
    } catch (error) {
      if (!(error instanceof CacheUnavailableError)) throw error;
    }
    const durable = await this.counters.voteTotals(targetId);
    if (this.differs(durable, exact)) {
      drifted++;
      discussionDriftCounter.add(1, { kind: 'durable' });
      found.push(
        `durable ups ${signed(durable.ups - exact.ups)} downs ${signed(durable.downs - exact.downs)}`,
      );
      await this.counters.addVoteDeltas(targetId, {
        ups: exact.ups - durable.ups,
        downs: exact.downs - durable.downs,
        wups: exact.wups - durable.wups,
        wdowns: exact.wdowns - durable.wdowns,
      });
    }
    if (found.length > 0)
      this.logger.warn(
        `vote counts drifted target=${targetId}: ${found.join(', ')}; repaired`,
      );
    await this.rerank(targetId, exact);
    return drifted;
  }

  /** Exact comment and reply counts of one post, from the rows. */
  async recountComments(postId: string): Promise<number> {
    const exact = await this.comments.scanCounts(postId);
    let drifted = 0;
    const stored = await this.counters.postComments(postId);
    if (stored !== exact.visible) {
      drifted++;
      discussionDriftCounter.add(1, { kind: 'comments' });
      await this.counters.adjustPostComments(postId, exact.visible - stored);
    }
    const ids = [...exact.replies.keys()];
    const known = await this.counters.replyCounts(ids);
    for (const id of ids) {
      const want = exact.replies.get(id)!;
      const have = known.get(id) ?? 0;
      if (want !== have) {
        drifted++;
        discussionDriftCounter.add(1, { kind: 'replies' });
        await this.counters.adjustReplies(id, want - have);
      }
    }
    try {
      await this.cache.setCommentCount(postId, exact.visible);
      for (const id of ids)
        await this.cache.setReplyCount(id, exact.replies.get(id)!);
    } catch (error) {
      if (!(error instanceof CacheUnavailableError)) throw error;
    }
    return drifted;
  }

  private differs(a: VoteCounts, b: VoteCounts): boolean {
    return (
      a.ups !== b.ups ||
      a.downs !== b.downs ||
      a.wups !== b.wups ||
      a.wdowns !== b.wdowns
    );
  }

  /** Re-scores the target in its ranking (posts: every board ranking; top-level comments: the thread's best). */
  private async rerank(targetId: string, exact: VoteCounts): Promise<void> {
    try {
      const post = await this.posts.get(targetId);
      if (post) {
        if (!post.deleted && !post.shadow)
          await this.ranking.place(post, exact);
        return;
      }
      const loc = await this.comments.getLocator(targetId);
      if (loc && loc.depth === 0)
        await this.ranking.placeRoot(loc.postId, targetId, exact);
    } catch (error) {
      if (!(error instanceof CacheUnavailableError)) throw error;
    }
  }
}
