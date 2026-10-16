import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import { SinkBackpressureError } from '@app/infrastructure/projections/errors';
import {
  feedConsumerPausedCounter,
  feedConsumerResumedCounter,
  feedFanoutCounter,
  feedFanoutDuration,
  feedFanoutLag,
  feedPushedCounter,
  feedSkippedInactiveCounter,
} from '../domain/feed-metrics';
import { idTime, isTimeUuid, sortableId } from '../domain/ids';
import {
  ANNOUNCEMENT_STORE,
  CELEBRITY_STORE,
  FOLLOW_GRAPH_STORE,
  TIMELINE_STORE,
  TimelineUnavailableError,
  type AnnouncementStore,
  type CelebrityStore,
  type FollowGraphStore,
  type TimelineStore,
} from '../domain/ports';
import { CelebrityRecentsService } from './celebrity-recents.service';
import { FollowQueryService } from './follow-query.service';

export interface FanoutRequest {
  itemId: string;
  authorId: string;
  kind: string;
  createdAt: string;
}

export interface FanoutResult {
  /** The item had been fanned out before: nothing was done. */
  replayed: boolean;
  pushed: number;
  skippedInactive: number;
  /** The author is a celebrity: nothing was pushed to followers; readers merge its recents. */
  celebrity: boolean;
}

/** How long the consumer's partition rests after the timeline store signalled saturation. */
export const BACKPRESSURE_COOLDOWN_MS = 1_000;

/**
 * Fan-out on write for one announced item (S26 C1-C6, R-7). A normal author's followers are paged 1,000 at a time; per
 * page one round trip tells who is active and one pipelined round trip pushes to those only (inactive users are rebuilt
 * by pull when they come back). A celebrity author (durable, sticky status; promoted here too when its follower count has
 * reached the threshold) is never pushed: the item goes to its bounded recents, which readers merge. A push of the same
 * entry twice is a no-op and equal timestamps order by id, so a redelivery after a failure part-way, or pushes arriving
 * out of order, cannot duplicate or reorder anything. The completion marker is written after the last page; a marked
 * item is skipped. A timeline store that fails or times out pauses the consumer (`SinkBackpressureError`) and nothing is
 * marked, so the redelivery after the cooldown does the work.
 */
@Injectable()
export class FanoutService {
  private readonly logger = new Logger(FanoutService.name);
  private paused = false;

  constructor(
    private readonly followers: FollowQueryService,
    private readonly recents: CelebrityRecentsService,
    @Inject(FOLLOW_GRAPH_STORE) private readonly graph: FollowGraphStore,
    @Inject(TIMELINE_STORE) private readonly timelines: TimelineStore,
    @Inject(CELEBRITY_STORE) private readonly celebrities: CelebrityStore,
    @Inject(ANNOUNCEMENT_STORE) private readonly marks: AnnouncementStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ApiConfigService,
  ) {}

  async fanOut(request: FanoutRequest): Promise<FanoutResult> {
    if (!isTimeUuid(request.itemId)) throw new RangeError('invalid item id');
    if (await this.marks.isFannedOut(request.itemId)) {
      feedFanoutCounter.add(1, { mode: 'push', outcome: 'replayed' });
      return {
        replayed: true,
        pushed: 0,
        skippedInactive: 0,
        celebrity: false,
      };
    }

    const started = this.clock.nowMs();
    const entry = {
      ms: idTime(request.itemId).getTime(),
      itemId: sortableId(request.itemId),
    };
    let page = 0;
    let result: Omit<FanoutResult, 'replayed'> & { followers: number };
    try {
      result = (await this.isCelebrity(request.authorId))
        ? await this.celebrityPath(request, entry)
        : await this.pushPath(request, entry, () => ++page);
    } catch (error) {
      return this.failed(request, page, error);
    }
    await this.marks.markFannedOut(request.itemId, this.clock.now());
    if (this.paused) {
      this.paused = false;
      feedConsumerResumedCounter.add(1);
    }

    const now = this.clock.nowMs();
    const mode = result.celebrity ? 'celebrity' : 'push';
    feedFanoutCounter.add(1, { mode, outcome: 'completed' });
    feedPushedCounter.add(result.pushed);
    feedSkippedInactiveCounter.add(result.skippedInactive);
    feedFanoutDuration.record(Math.max(0, now - started) / 1_000);
    feedFanoutLag.record(Math.max(0, now - entry.ms) / 1_000);
    this.logger.log({
      event: 'feed.fanout.completed',
      authorId: request.authorId,
      itemId: request.itemId,
      followers: result.followers,
      pushed: result.pushed,
      skippedInactive: result.skippedInactive,
      celebrity: result.celebrity,
      durationMs: Math.max(0, now - started),
      lagMs: Math.max(0, now - entry.ms),
    });
    return {
      replayed: false,
      pushed: result.pushed,
      skippedInactive: result.skippedInactive,
      celebrity: result.celebrity,
    };
  }

  /** Sticky status, or a follower count that reached the threshold (promoted now, once). */
  private async isCelebrity(authorId: string): Promise<boolean> {
    if (await this.celebrities.isCelebrity(authorId)) return true;
    const count = await this.graph.followerCount(authorId);
    if (count < this.config.get('feed_celebrity_threshold')) return false;
    await this.celebrities.promote(authorId, count, this.clock.now());
    return true;
  }

  private async celebrityPath(
    request: FanoutRequest,
    entry: { ms: number; itemId: string },
  ) {
    await this.recents.record(request.authorId, entry);
    return {
      pushed: 0,
      skippedInactive: 0,
      celebrity: true,
      followers: await this.graph.followerCount(request.authorId),
    };
  }

  private async pushPath(
    request: FanoutRequest,
    entry: { ms: number; itemId: string },
    nextPage: () => number,
  ) {
    const limit = this.config.get('feed_fanout_page_size');
    const window = this.config.get('feed_timeline_window');
    let cursor: string | undefined;
    let pushed = 0;
    let skipped = 0;
    do {
      nextPage();
      const page = await this.followers.getFollowerIds(request.authorId, {
        limit,
        cursor,
      });
      const active = await this.timelines.activeAmong(page.ids);
      const targets = page.ids.filter((id) => active.has(id));
      if (targets.length) await this.timelines.push(targets, entry, window);
      pushed += targets.length;
      skipped += page.ids.length - targets.length;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return {
      pushed,
      skippedInactive: skipped,
      celebrity: false,
      followers: pushed + skipped,
    };
  }

  private failed(request: FanoutRequest, page: number, error: unknown): never {
    feedFanoutCounter.add(1, { mode: 'push', outcome: 'failed' });
    this.logger.error({
      event: 'feed.fanout.failed',
      authorId: request.authorId,
      itemId: request.itemId,
      page,
      cause: error instanceof Error ? error.name : 'unknown',
    });
    if (error instanceof TimelineUnavailableError) {
      // the timeline store is saturated or down: rest the partition, then the redelivery finishes the work
      this.paused = true;
      feedConsumerPausedCounter.add(1);
      throw new SinkBackpressureError(
        'timeline store unavailable',
        BACKPRESSURE_COOLDOWN_MS,
      );
    }
    throw error;
  }
}
