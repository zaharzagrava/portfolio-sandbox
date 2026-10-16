import { Inject, Injectable, Logger } from '@nestjs/common';
import type { FeedItemView, FeedPage } from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import { settleWithConcurrency } from '@app/common/core/promise-pool';
import type { FeedCursorCodec } from '../domain/feed-cursor';
import { invalidFeedCursor } from '../domain/feed-errors';
import { feedDegradedCounter } from '../domain/feed-metrics';
import { idTime, sortableId } from '../domain/ids';
import { mergeNewestFirst, type TimelineEntry } from '../domain/merge';
import {
  CELEBRITY_STORE,
  FEED_CURSOR_CODEC,
  FOLLOW_GRAPH_STORE,
  TIMELINE_STORE,
  TimelineUnavailableError,
  type CelebrityStore,
  type FollowGraphStore,
  type TimelineStore,
} from '../domain/ports';
import { withTimeout } from '../domain/with-timeout';
import { CelebrityRecentsService } from './celebrity-recents.service';
import { FeedHydrationService } from './feed-hydration.service';
import { TimelineRebuildService } from './timeline-rebuild.service';

const DAY_MS = 86_400_000;
/** Celebrities read at once for one page. */
const CELEBRITY_CONCURRENCY = 16;

class CelebrityTimeout extends Error {}

interface ReadState {
  degraded: boolean;
  /**
   * The pushed timeline and the celebrity recents are not used for this response (the cache is down, or another request
   * is rebuilding it): every followed account is read by pull.
   */
  skipPushed: boolean;
}

interface Followed {
  all: string[];
  celebrities: string[];
  /** Not celebrities: pushed, and rebuilt/pulled from history. */
  normal: string[];
}

/**
 * The home feed of one reader (S26 D1-D6, FR-040, FR-041). Candidates are the reader's pushed timeline, the recents of
 * every celebrity they follow and a pull continuation from the durable per-author history; the pull runs only when the
 * pushed entries below the cursor run out (the 800-entry window, a reader who was away), so paging never dead-ends at
 * the window. A returning reader, or one whose timeline is missing or incomplete, gets it rebuilt first. The merge is by
 * `(ms, sortable id)` descending and de-duplicates; the cursor is the position of the last item returned. A fill loop asks
 * for more candidates when hydration leaves items out, bounded by the scan cap (5 x limit). Items older than the retention
 * are never served. A cache that fails is replaced by pull and the page is marked `degraded`; a durable store that fails
 * is `503 feed_unavailable` (thrown by the store layer, no internals).
 */
@Injectable()
export class FeedReadService {
  private readonly logger = new Logger(FeedReadService.name);

  constructor(
    @Inject(FOLLOW_GRAPH_STORE) private readonly graph: FollowGraphStore,
    @Inject(TIMELINE_STORE) private readonly timelines: TimelineStore,
    @Inject(CELEBRITY_STORE) private readonly celebrityStore: CelebrityStore,
    @Inject(FEED_CURSOR_CODEC) private readonly cursors: FeedCursorCodec,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly hydration: FeedHydrationService,
    private readonly rebuild: TimelineRebuildService,
    private readonly recents: CelebrityRecentsService,
    private readonly config: ApiConfigService,
  ) {}

  async page(
    userId: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<FeedPage> {
    const before =
      cursor === undefined ? null : this.cursors.decodeFeed(cursor);
    if (cursor !== undefined && !before) throw invalidFeedCursor();

    const state: ReadState = { degraded: false, skipPushed: false };
    let wasActive = false;
    try {
      // reading the feed marks the reader active and slides the marker
      wasActive = await this.timelines.touchActive(userId);
    } catch (error) {
      this.cacheFailed(state, error);
    }

    const all = await this.graph.allFollowing(userId);
    if (!all.length) return { items: [], nextCursor: null };
    const celebrities = [...(await this.celebrityStore.areCelebrities(all))];
    const celebritySet = new Set(celebrities);
    const followed: Followed = {
      all,
      celebrities,
      normal: all.filter((a) => !celebritySet.has(a)),
    };
    if (!state.skipPushed)
      await this.ensureTimeline(userId, followed.normal, wasActive, state);

    const followedSet = new Set(all);
    const cutoff =
      this.clock.nowMs() - this.config.get('feed_retention_days') * DAY_MS;
    const scanCap = limit * this.config.get('feed_scan_cap_factor');

    const collected: FeedItemView[] = [];
    let position: TimelineEntry | null = before;
    let scanned = 0;
    let exhausted = false;
    while (collected.length <= limit && scanned < scanCap && !exhausted) {
      const want = limit + 1;
      const entries = await this.candidates(
        userId,
        followed,
        position,
        want,
        cutoff,
        state,
      );
      if (!entries.length) {
        exhausted = true;
        break;
      }
      scanned += entries.length;
      const hydrated = await this.hydration.hydrate(entries, followedSet);
      if (hydrated.degraded) this.degrade(state, 'hydration');
      collected.push(...hydrated.items);
      position = entries[entries.length - 1];
      if (entries.length < want) exhausted = true;
    }

    const items = collected.slice(0, limit);
    let next: TimelineEntry | null = null;
    if (collected.length > limit)
      next = this.positionOf(items[items.length - 1]);
    else if (!exhausted) next = position;
    return {
      items,
      nextCursor: next ? this.cursors.encodeFeed(next) : null,
      ...(state.degraded && { degraded: true as const }),
    };
  }

  private positionOf(item: FeedItemView): TimelineEntry {
    return {
      ms: idTime(item.itemId).getTime(),
      itemId: sortableId(item.itemId),
    };
  }

  private degrade(state: ReadState, reason: string): void {
    if (!state.degraded) this.logger.warn({ event: 'feed.degraded', reason });
    state.degraded = true;
    feedDegradedCounter.add(1, { reason });
  }

  /** A failed cache call: the pushed timeline is replaced by pull for this response. Anything else is not ours to hide. */
  private cacheFailed(state: ReadState, error: unknown): void {
    if (!(error instanceof TimelineUnavailableError)) throw error;
    state.skipPushed = true;
    this.degrade(state, 'timeline_down');
  }

  /** A returning reader, or a missing or incomplete timeline, is rebuilt from history before the read (D4). */
  private async ensureTimeline(
    userId: string,
    authors: string[],
    wasActive: boolean,
    state: ReadState,
  ): Promise<void> {
    try {
      if (wasActive && (await this.timelines.isComplete(userId))) return;
      const outcome = await this.rebuild.rebuild(userId, authors);
      if (outcome === 'joined') state.skipPushed = true;
      else if (outcome === 'incomplete') this.degrade(state, 'history_timeout');
    } catch (error) {
      this.cacheFailed(state, error);
    }
  }

  /** The next `want` entries after `position`, newest first. */
  private async candidates(
    userId: string,
    followed: Followed,
    position: TimelineEntry | null,
    want: number,
    cutoffMs: number,
    state: ReadState,
  ): Promise<TimelineEntry[]> {
    const lists: TimelineEntry[][] = [];
    let pushedCount = 0;
    if (!state.skipPushed)
      try {
        const pushed = (
          await this.timelines.read(userId, position, want)
        ).filter((e) => e.ms >= cutoffMs);
        pushedCount = pushed.length;
        lists.push(pushed);
        lists.push(
          ...(await this.celebrityLists(
            followed.celebrities,
            position,
            want,
            cutoffMs,
            state,
          )),
        );
      } catch (error) {
        this.cacheFailed(state, error);
      }
    // the pushed entries below the cursor ran out (or the cache is not usable): the durable history continues
    if (state.skipPushed || pushedCount < want)
      lists.push(
        ...(await this.pull(
          state.skipPushed ? followed.all : followed.normal,
          position,
          want,
          cutoffMs,
          state,
        )),
      );
    return mergeNewestFirst(lists, want, position ?? undefined);
  }

  /**
   * The recents of each followed celebrity. One that fails or runs out of time is left out of this response only
   * (`degraded`); the cache being down altogether throws to the caller, which falls back to pull.
   */
  private async celebrityLists(
    celebrities: string[],
    position: TimelineEntry | null,
    want: number,
    cutoffMs: number,
    state: ReadState,
  ): Promise<TimelineEntry[][]> {
    if (!celebrities.length) return [];
    const timeoutMs = this.config.get('feed_celebrity_timeout_ms');
    const settled = await settleWithConcurrency(
      celebrities,
      CELEBRITY_CONCURRENCY,
      async (author) => {
        const recent = (
          await withTimeout(
            this.recents.read(author, position, want),
            timeoutMs,
            () => new CelebrityTimeout(),
          )
        ).filter((e) => e.ms >= cutoffMs);
        if (recent.length >= want || position === null) return [recent];
        // deeper than the bounded list reaches: the history continues it
        const deeper = await this.rebuild.history(
          [author],
          recent.length ? recent[recent.length - 1] : position,
          want,
          new Date(cutoffMs),
        );
        return [recent, ...deeper.lists];
      },
    );
    const lists: TimelineEntry[][] = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') lists.push(...result.value);
      else if (result.reason instanceof CelebrityTimeout)
        this.degrade(state, 'celebrity_timeout');
      else if (result.reason instanceof TimelineUnavailableError)
        throw result.reason;
      else throw result.reason;
    }
    return lists;
  }

  private async pull(
    authors: string[],
    position: TimelineEntry | null,
    want: number,
    cutoffMs: number,
    state: ReadState,
  ): Promise<TimelineEntry[][]> {
    const { lists, timedOut } = await this.rebuild.history(
      authors,
      position,
      want,
      new Date(cutoffMs),
    );
    if (timedOut) this.degrade(state, 'history_timeout');
    return lists;
  }
}
