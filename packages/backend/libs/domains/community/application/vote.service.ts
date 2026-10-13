import { Inject, Injectable, Logger } from '@nestjs/common';
import type { VoteResult } from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import { evaluateAnomaly } from '../domain/anomaly';
import {
  selfVoteNotAllowed,
  serviceUnavailable,
  targetDeleted,
  targetNotFound,
  voteInProgress,
} from '../domain/discussion-errors';
import { DiscussionVoteAnomalyDetected } from '../domain/discussion-events';
import {
  discussionAnomalyCounter,
  discussionVoteCounter,
} from '../domain/discussions-metrics';
import { isTimeUuid } from '../domain/ids';
import {
  ACCOUNT_DIRECTORY,
  ANOMALY_TRACKER,
  CacheUnavailableError,
  COMMENT_STORE,
  COUNT_CACHE,
  EVENT_STORE,
  POST_STORE,
  SHADOW_STORE,
  VOTE_DELTA_BUFFER,
  VOTE_STORE,
  type AccountDirectory,
  type AnomalyTracker,
  type CommentStore,
  type CountCache,
  type EventStore,
  type PostStore,
  type ShadowStore,
  type TargetType,
  type VoteDeltaBuffer,
  type VoteStore,
} from '../domain/ports';
import {
  isNoop,
  voteDelta,
  type VoteCounts,
  type VoteDelta,
  type VoteRecord,
} from '../domain/vote-transition';
import { voteWeight } from '../domain/vote-weight';
import { CountsService, swallowCache } from './counts.service';
import { DiscussionIds, recordEvent } from './discussion-support';
import { RankingService } from './ranking.service';

export type VoteValue = -1 | 0 | 1;

interface Resolved {
  type: TargetType;
  postId: string;
  boardId: string;
  /** Posts and top-level comments are ranked; replies are not. */
  rankedAs: 'post' | 'root' | null;
  createdAt: Date;
}

const MAX_ATTEMPTS = 2;

/**
 * Votes (S25 US3, R-1): one record per (user, target) changed by compare-and-set; the displayed counts follow the
 * committed `(previous, next)` pair, so they equal a recount of the records. There is no lock: the store arbitrates.
 */
@Injectable()
export class VoteService {
  private readonly logger = new Logger(VoteService.name);

  constructor(
    @Inject(POST_STORE) private readonly posts: PostStore,
    @Inject(COMMENT_STORE) private readonly comments: CommentStore,
    @Inject(VOTE_STORE) private readonly votes: VoteStore,
    @Inject(COUNT_CACHE) private readonly cache: CountCache,
    @Inject(VOTE_DELTA_BUFFER) private readonly buffer: VoteDeltaBuffer,
    @Inject(SHADOW_STORE) private readonly shadow: ShadowStore,
    @Inject(ACCOUNT_DIRECTORY) private readonly directory: AccountDirectory,
    @Inject(ANOMALY_TRACKER) private readonly anomalies: AnomalyTracker,
    @Inject(EVENT_STORE) private readonly events: EventStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly ids: DiscussionIds,
    private readonly counts: CountsService,
    private readonly ranking: RankingService,
    private readonly config: ApiConfigService,
  ) {}

  async vote(
    userId: string,
    targetId: string,
    value: VoteValue,
  ): Promise<VoteResult> {
    const target = await this.resolve(userId, targetId);
    await this.requireCache(targetId);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const current = await this.votes.get(targetId, userId);
      if ((current?.value ?? 0) === value) {
        // Replay or no-op retraction: nothing changes, the answer is the same complete result.
        discussionVoteCounter.add(1, { outcome: 'replayed' });
        const counts = await this.counts.voteCounts(targetId);
        return this.format(targetId, target.type, counts, value);
      }
      const next: VoteRecord | null =
        value === 0 ? null : { value, weight: await this.weightFor(userId) };
      const committed = await this.votes.cas(
        targetId,
        userId,
        target.type,
        current,
        next,
        this.clock.now(),
      );
      if (!committed) continue;

      const delta = voteDelta(
        current ? { value: current.value, weight: current.weight } : null,
        next,
      );
      const counts = await this.apply(targetId, delta);
      discussionVoteCounter.add(1, {
        outcome:
          next === null ? 'retracted' : current === null ? 'cast' : 'changed',
      });
      await this.afterCommit(targetId, target, counts, delta, next);
      return this.format(targetId, target.type, counts, value);
    }
    discussionVoteCounter.add(1, { outcome: 'busy' });
    throw voteInProgress();
  }

  // ---- steps -----------------------------------------------------------------------------------------------------

  /** Server-side target resolution (FR-021): post or comment, visibility, own-content and tombstone rules. */
  private async resolve(userId: string, targetId: string): Promise<Resolved> {
    if (!isTimeUuid(targetId)) throw targetNotFound();
    const post = await this.posts.get(targetId);
    if (post) {
      if (post.deleted || (post.shadow && post.authorId !== userId))
        throw targetNotFound();
      if (post.authorId === userId) throw selfVoteNotAllowed();
      return {
        type: 'post',
        postId: post.postId,
        boardId: post.boardId,
        rankedAs: 'post',
        createdAt: post.createdAt,
      };
    }
    const loc = await this.comments.getLocator(targetId);
    if (!loc) throw targetNotFound();
    const row = await this.comments.getRow(loc.postId, loc.bucket, loc.path);
    if (!row) throw targetNotFound();
    if (row.deleted) throw targetDeleted();
    if (row.shadow && row.authorId !== userId) throw targetNotFound();
    if (row.authorId === userId) throw selfVoteNotAllowed();
    const parent = await this.posts.get(row.postId);
    if (!parent || parent.deleted) throw targetNotFound();
    return {
      type: 'comment',
      postId: row.postId,
      boardId: parent.boardId,
      rankedAs: row.depth === 0 ? 'root' : null,
      createdAt: row.createdAt,
    };
  }

  /** Counting without the cache could double a delta: refuse the vote before anything is recorded (AS-51). */
  private async requireCache(targetId: string): Promise<void> {
    try {
      await this.cache.votes(targetId);
    } catch (error) {
      if (error instanceof CacheUnavailableError) {
        discussionVoteCounter.add(1, { outcome: 'unavailable' });
        throw serviceUnavailable();
      }
      throw error;
    }
  }

  /** Ranking weight of a new or changed vote: 0 for a shadow-banned, young or unresolved account (FR-025). */
  private async weightFor(userId: string): Promise<0 | 1> {
    const shadowBanned = await this.shadow.isBanned(userId);
    let createdAt: Date | null = null;
    try {
      createdAt =
        (await this.directory.lookup([userId])).get(userId)?.createdAt ?? null;
    } catch {
      this.logger.warn('account lookup failed: vote weight set to 0');
    }
    return voteWeight({
      createdAt,
      shadowBanned,
      now: this.clock.now(),
      minAgeHours: this.config.get('discussions_account_age_hours'),
    });
  }

  /** Applies the delta to the cached counts; a lost entry is rebuilt from the records (which include this vote). */
  private async apply(targetId: string, delta: VoteDelta): Promise<VoteCounts> {
    try {
      const updated = await this.cache.applyVoteDelta(targetId, delta);
      return updated ?? (await this.counts.recountVotes(targetId));
    } catch (error) {
      if (error instanceof CacheUnavailableError) throw serviceUnavailable();
      throw error;
    }
  }

  private async afterCommit(
    targetId: string,
    target: Resolved,
    counts: VoteCounts,
    delta: VoteDelta,
    next: VoteRecord | null,
  ): Promise<void> {
    if (!isNoop(delta))
      await this.buffer
        .add(targetId, {
          ups: delta.dUps,
          downs: delta.dDowns,
          wups: delta.dWups,
          wdowns: delta.dWdowns,
        })
        .catch(swallowCache);
    try {
      if (target.rankedAs === 'post')
        await this.ranking.place(
          {
            postId: targetId,
            boardId: target.boardId,
            createdAt: target.createdAt,
          },
          counts,
        );
      else if (target.rankedAs === 'root')
        await this.ranking.placeRoot(target.postId, targetId, counts);
    } catch (error) {
      swallowCache(error);
    }
    if (next && next.weight === 0) await this.noteZeroWeight(targetId, target);
  }

  /** FR-053: ten zero-weight votes inside ten minutes record one anomaly event per target per hour. */
  private async noteZeroWeight(
    targetId: string,
    target: Resolved,
  ): Promise<void> {
    try {
      const nowMs = this.clock.nowMs();
      const windowSeconds = this.config.get(
        'discussions_anomaly_window_seconds',
      );
      const seen = await this.anomalies.note(targetId, nowMs, windowSeconds);
      const verdict = evaluateAnomaly({
        timestamps: seen.timestamps,
        now: nowMs,
        lastSentAt: seen.lastSentAt,
        threshold: this.config.get('discussions_anomaly_threshold'),
        windowSeconds,
      });
      if (!verdict.fire) return;
      await this.anomalies.markSent(targetId, nowMs);
      discussionAnomalyCounter.add(1);
      await this.events.record(
        recordEvent(
          DiscussionVoteAnomalyDetected,
          target.postId,
          {
            targetId,
            targetType: target.type,
            boardId: target.boardId,
            zeroWeightVotes: verdict.count,
            windowSeconds: verdict.windowSeconds,
          },
          this.ids.now(),
        ),
      );
    } catch (error) {
      this.logger.warn(`anomaly check skipped cause=${(error as Error).name}`);
    }
  }

  private format(
    targetId: string,
    type: TargetType,
    c: VoteCounts,
    myVote: VoteValue,
  ): VoteResult {
    return {
      targetId,
      targetType: type,
      ups: c.ups,
      downs: c.downs,
      score: c.ups - c.downs,
      myVote,
    };
  }
}
