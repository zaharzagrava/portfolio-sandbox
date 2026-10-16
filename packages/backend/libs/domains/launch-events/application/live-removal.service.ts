import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import {
  commentNotFound,
  liveUnavailable,
  streamNotFound,
} from '../domain/live-errors';
import { streamTopic } from '../domain/live-keys';
import {
  COMMENT_HISTORY_READER,
  LIVE_STREAMS,
  RECENT_COMMENT_STORE,
  REMOVAL_CLAIMS,
  type CommentHistoryReader,
  type LiveStreamRepository,
  type RecentCommentStore,
  type RemovalClaims,
} from '../domain/live-ports';
import { LiveEventLog } from './live-event-log';
import { logLiveError, logLiveWarn } from './live-log';
import { liveMetrics } from './live-metrics';

export type RemovalSource =
  { reason: 'moderator'; actorId: string } | { reason: 'auto'; score: number };

/**
 * Removing a comment, by staff or by the asynchronous classifier (FR-027). The removal makes itself durable on the event
 * stream FIRST, then drops the comment from the recent list and tells the viewers. A claim marker makes it at most one
 * event per comment in 24 hours and is released when the durable write fails, so a retry completes the job.
 */
@Injectable()
export class LiveRemovalService {
  private readonly logger = new Logger(LiveRemovalService.name);

  constructor(
    @Inject(LIVE_STREAMS) private readonly streams: LiveStreamRepository,
    @Inject(RECENT_COMMENT_STORE) private readonly recent: RecentCommentStore,
    @Inject(REMOVAL_CLAIMS) private readonly claims: RemovalClaims,
    @Inject(COMMENT_HISTORY_READER)
    private readonly history: CommentHistoryReader,
    private readonly events: LiveEventLog,
    private readonly realtime: RealtimePublisher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Staff removes a comment of their own shop's stream. */
  async removeByStaff(
    shopId: string,
    streamId: string,
    commentId: string,
    actorId: string,
  ): Promise<void> {
    const stream = await this.streams.findById(streamId);
    if (!stream || stream.shopId !== shopId) throw streamNotFound();
    await this.remove(
      streamId,
      commentId,
      { reason: 'moderator', actorId },
      false,
    );
  }

  /** The asynchronous classifier removes a comment: the event it read proves the comment exists. */
  removeAuto(
    streamId: string,
    commentId: string,
    score: number,
  ): Promise<void> {
    return this.remove(streamId, commentId, { reason: 'auto', score }, true);
  }

  private async remove(
    streamId: string,
    commentId: string,
    source: RemovalSource,
    proven: boolean,
  ): Promise<void> {
    if (!proven && !(await this.exists(streamId, commentId)))
      throw commentNotFound();

    if (!(await this.claims.claim(streamId, commentId))) {
      // Removed already (or being removed): finish what a failed first try may have left, announce nothing twice.
      if (await this.recent.remove(streamId, commentId))
        await this.announce(streamId, commentId);
      return;
    }
    try {
      await this.events.commentRemoved({
        streamId,
        commentId,
        at: this.clock.nowMs(),
        reason: source.reason,
        ...(source.reason === 'moderator'
          ? { actorId: source.actorId }
          : { score: source.score }),
      });
    } catch (error) {
      await this.claims.release(streamId, commentId).catch(() => undefined);
      logLiveError(
        this.logger,
        'removal_not_durable',
        { streamId, commentId },
        error,
      );
      throw liveUnavailable();
    }
    liveMetrics.removals.add(1, { source: source.reason });
    try {
      await this.recent.remove(streamId, commentId);
    } catch (error) {
      logLiveError(
        this.logger,
        'removal_not_applied',
        { streamId, commentId },
        error,
      );
      throw liveUnavailable();
    }
    await this.announce(streamId, commentId);
  }

  private async exists(streamId: string, commentId: string): Promise<boolean> {
    try {
      if ((await this.recent.list(streamId)).some((c) => c.id === commentId))
        return true;
      if (await this.claims.isClaimed(streamId, commentId)) return true;
      return await this.history.exists(streamId, commentId);
    } catch (error) {
      logLiveError(
        this.logger,
        'comment_lookup_failed',
        { streamId, commentId },
        error,
      );
      throw liveUnavailable();
    }
  }

  private async announce(streamId: string, commentId: string): Promise<void> {
    await this.realtime
      .publish(streamTopic(streamId), 'comment_removed', { id: commentId })
      .catch((error: Error) =>
        logLiveWarn(
          this.logger,
          'removal_not_announced',
          { streamId, commentId },
          error,
        ),
      );
  }
}
