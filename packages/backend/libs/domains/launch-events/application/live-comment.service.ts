import { Inject, Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import {
  postCommentRequestSchema,
  type LiveComment,
} from '@marketplace-sandbox/contracts';
import { AppError } from '@app/common/errors';
import { CLOCK, Clock } from '@app/common/core/clock';
import { sleep } from '@app/common/core/backoff';
import { authorHandle } from '../domain/author-handle';
import { isValidCommentLength, normalizeComment } from '../domain/comment-text';
import { fieldIssues } from '../domain/field-issues';
import {
  clientIdReused,
  commentBlocked,
  liveUnavailable,
  liveValidationFailed,
  streamNotFound,
  streamNotLive,
  userMuted,
} from '../domain/live-errors';
import {
  CLIENT_IDS,
  COMMENT_FEED,
  RECENT_COMMENT_STORE,
  type ClientIdRecord,
  type ClientIds,
  type CommentFeed,
  type RecentCommentStore,
} from '../domain/live-ports';
import { syncModeration } from '../domain/moderation';
import { LiveEventLog } from './live-event-log';
import { LiveLimits } from './live-limits';
import { logLiveError } from './live-log';
import { liveMetrics } from './live-metrics';
import { LiveModerationService } from './live-moderation.service';
import { LiveMutes } from './live-mutes.service';
import { LiveStateCache, type LiveStreamState } from './live-state-cache';

export interface PostedComment {
  comment: LiveComment;
  /** `201` for a new comment, `200` for a retry that returned the original. */
  created: boolean;
}

/** How long a retry waits for the request that holds its `clientId` to finish before it finishes the job itself. */
const IN_FLIGHT_WAIT_MS = 2_000;
const POLL_MS = 20;

/**
 * The comment path (FR-018 to FR-026): checks in the documented order, then durable first (the event stream), visible
 * second (recent list, then the private feed). Nothing here reads the relational database when the stream state is warm.
 * A `clientId` makes a retry return the original comment instead of making a second one.
 */
@Injectable()
export class LiveCommentService {
  private readonly logger = new Logger(LiveCommentService.name);

  constructor(
    private readonly limits: LiveLimits,
    private readonly state: LiveStateCache,
    private readonly mutes: LiveMutes,
    private readonly moderation: LiveModerationService,
    private readonly events: LiveEventLog,
    @Inject(RECENT_COMMENT_STORE) private readonly recent: RecentCommentStore,
    @Inject(COMMENT_FEED) private readonly feed: CommentFeed,
    @Inject(CLIENT_IDS) private readonly clientIds: ClientIds,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async post(
    streamId: string,
    userId: string,
    body: unknown,
  ): Promise<PostedComment> {
    await this.limits.take('live.comment', `user:${userId}`);
    const { text, clientId } = this.parse(body);

    try {
      const stream = await this.liveStream(streamId);
      if (await this.mutes.isMuted(streamId, userId)) {
        liveMetrics.comments.add(1, { result: 'muted', reason: 'none' });
        throw userMuted();
      }
      const verdict = syncModeration(text);
      if (!verdict.ok) {
        liveMetrics.comments.add(1, {
          result: 'blocked',
          reason: verdict.reason,
        });
        throw commentBlocked(verdict.reason);
      }
      const staff = await this.moderation.isStaff(stream.shopId, userId);
      const at = this.clock.nowMs();
      const comment: LiveComment = {
        id: this.nextId(at),
        streamId,
        authorId: userId,
        authorName: authorHandle(userId, streamId),
        text,
        at,
        ...(staff && { priority: true as const }),
      };
      if (!clientId) {
        await this.deliver(comment);
        return { comment, created: true };
      }
      return await this.postWithClientId(comment, clientId);
    } catch (error) {
      if (error instanceof AppError) throw error;
      logLiveError(this.logger, 'comment_path_failed', { streamId }, error);
      liveMetrics.comments.add(1, { result: 'unavailable', reason: 'none' });
      throw liveUnavailable();
    }
  }

  /**
   * A time-ordered id (uuidv7) built on the injected clock, with a counter so that ids made in the same millisecond by
   * this process still sort in the order they were made (the viewers' batches and the history sort by id). The time of
   * the id is always `at`, also when the clock moved back: the history finds a comment's partition by the time in its id.
   */
  private lastMs = 0;
  private seq = 0;
  private nextId(at: number): string {
    this.seq = at === this.lastMs ? this.seq + 1 : 0;
    this.lastMs = at;
    return uuidv7({ msecs: at, seq: this.seq });
  }

  private parse(body: unknown): { text: string; clientId?: string } {
    const parsed = postCommentRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      liveMetrics.comments.add(1, { result: 'rejected', reason: 'none' });
      throw liveValidationFailed(fieldIssues(parsed.error));
    }
    const normalized = normalizeComment(parsed.data.text);
    if (!isValidCommentLength(normalized.length)) {
      liveMetrics.comments.add(1, { result: 'rejected', reason: 'none' });
      throw liveValidationFailed([
        {
          field: 'text',
          code: normalized.length === 0 ? 'too_small' : 'too_big',
        },
      ]);
    }
    return {
      text: normalized.text,
      clientId: parsed.data.clientId?.toLowerCase(),
    };
  }

  /** The stream must exist (`404`) and be `LIVE` (`409`), from the cached state. */
  private async liveStream(streamId: string): Promise<LiveStreamState> {
    const stream = await this.state.get(streamId);
    if (!stream) {
      liveMetrics.comments.add(1, { result: 'rejected', reason: 'none' });
      throw streamNotFound();
    }
    if (stream.status !== 'LIVE') {
      liveMetrics.comments.add(1, { result: 'rejected', reason: 'none' });
      throw streamNotLive();
    }
    return stream;
  }

  private async postWithClientId(
    comment: LiveComment,
    clientId: string,
  ): Promise<PostedComment> {
    const { streamId, authorId } = comment;
    for (let attempt = 0; attempt < 3; attempt++) {
      const claim = await this.clientIds.claim(streamId, authorId, clientId, {
        id: comment.id,
        at: comment.at,
        text: comment.text,
        state: 'pending',
      });
      if (claim.result === 'claimed') {
        await this.deliver(comment, clientId);
        return { comment, created: true };
      }
      if (claim.record.text !== comment.text) throw clientIdReused();
      const original: LiveComment = {
        ...comment,
        id: claim.record.id,
        at: claim.record.at,
      };
      const settled = await this.settle(original, clientId, claim.record);
      if (settled === 'retry') continue; // the first request failed before the event was durable: post anew
      return { comment: original, created: false };
    }
    throw liveUnavailable();
  }

  /**
   * A retry of a claimed `clientId`: returns once the original is visible. A first request that is still running is
   * waited for; one that stopped after the durable write is finished here (the recent list takes the same comment once,
   * the feed gets it again only when the first attempt never reached it).
   */
  private async settle(
    original: LiveComment,
    clientId: string,
    seen: ClientIdRecord,
  ): Promise<'done' | 'retry'> {
    const { streamId, authorId } = original;
    let record: ClientIdRecord | null = seen;
    for (
      let polls = 0;
      record &&
      record.state !== 'done' &&
      record.state !== 'failed' &&
      polls < IN_FLIGHT_WAIT_MS / POLL_MS;
      polls++
    ) {
      await sleep(POLL_MS);
      record = await this.clientIds.read(streamId, authorId, clientId);
    }
    if (!record) return 'retry';
    if (record.state === 'done') {
      liveMetrics.comments.add(1, { result: 'replayed', reason: 'none' });
      return 'done';
    }
    if (record.state === 'pending') throw liveUnavailable();
    await this.makeVisible(original, clientId);
    liveMetrics.comments.add(1, { result: 'replayed', reason: 'none' });
    return 'done';
  }

  /** Durable on the event stream first; visible second. */
  private async deliver(
    comment: LiveComment,
    clientId?: string,
  ): Promise<void> {
    try {
      await this.events.commentPosted(comment);
    } catch (error) {
      logLiveError(
        this.logger,
        'comment_not_durable',
        { streamId: comment.streamId, commentId: comment.id },
        error,
      );
      if (clientId)
        await this.clientIds
          .release(comment.streamId, comment.authorId, clientId)
          .catch(() => undefined);
      liveMetrics.comments.add(1, { result: 'unavailable', reason: 'none' });
      throw liveUnavailable();
    }
    if (clientId)
      await this.clientIds
        .setState(comment.streamId, comment.authorId, clientId, 'durable')
        .catch(() => undefined);
    await this.makeVisible(comment, clientId);
    liveMetrics.comments.add(1, { result: 'accepted', reason: 'none' });
  }

  private async makeVisible(
    comment: LiveComment,
    clientId?: string,
  ): Promise<void> {
    try {
      await this.recent.add(comment);
      await this.feed.publish(comment);
    } catch (error) {
      logLiveError(
        this.logger,
        'comment_durable_not_visible',
        { streamId: comment.streamId, commentId: comment.id },
        error,
      );
      if (clientId)
        await this.clientIds
          .setState(comment.streamId, comment.authorId, clientId, 'failed')
          .catch(() => undefined);
      liveMetrics.comments.add(1, { result: 'unavailable', reason: 'none' });
      throw liveUnavailable();
    }
    if (clientId)
      await this.clientIds
        .setState(comment.streamId, comment.authorId, clientId, 'done')
        .catch(() => undefined);
  }
}
