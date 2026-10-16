import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import { settleWithConcurrency } from '@app/common/core/promise-pool';
import { feedRebuildCounter } from '../domain/feed-metrics';
import { sortableId } from '../domain/ids';
import type { TimelineEntry } from '../domain/merge';
import {
  FEED_ITEM_STORE,
  TIMELINE_STORE,
  type FeedItemStore,
  type TimelineStore,
} from '../domain/ports';
import { Semaphore } from '../domain/semaphore';
import { withTimeout } from '../domain/with-timeout';

const DAY_MS = 86_400_000;
/** What a rebuild reads per author and how far back (FR-042). */
export const REBUILD_PER_AUTHOR = 50;
export const REBUILD_DAYS = 60;

class HistoryTimeout extends Error {}

export interface HistoryRead {
  lists: TimelineEntry[][];
  /** At least one author's history read ran out of time: its entries are missing from `lists`. */
  timedOut: boolean;
}

export type RebuildOutcome = 'complete' | 'incomplete' | 'joined';

/**
 * Reads the durable per-author history for a reader, and rebuilds a missing timeline from it (S26 D4, R-8). Every read is
 * time-bounded; at most `feed_rebuild_concurrency` run at once for one request and at most `feed_rebuild_semaphore` in
 * the process. A rebuild is single flight per reader (`fd:rb`), merges into the timeline additively (so a push that lands
 * meanwhile survives, and the same entry twice is one), and records completion only when every author was read.
 */
@Injectable()
export class TimelineRebuildService {
  private readonly logger = new Logger(TimelineRebuildService.name);
  private semaphore: Semaphore | null = null;

  constructor(
    @Inject(TIMELINE_STORE) private readonly timelines: TimelineStore,
    @Inject(FEED_ITEM_STORE) private readonly items: FeedItemStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ApiConfigService,
  ) {}

  /**
   * The newest `perAuthor` entries of each author strictly older than `before`, no older than `notBefore`.
   * A store failure is thrown (the durable store is down: nothing honest can be served).
   */
  async history(
    authors: string[],
    before: TimelineEntry | null,
    perAuthor: number,
    notBefore: Date,
  ): Promise<HistoryRead> {
    if (!authors.length) return { lists: [], timedOut: false };
    const now = this.clock.now();
    const timeoutMs = this.config.get('feed_history_timeout_ms');
    const gate = this.gate();
    const settled = await settleWithConcurrency(
      authors,
      this.config.get('feed_rebuild_concurrency'),
      (author) =>
        gate.run(() =>
          withTimeout(
            this.items.authorHistory(author, before, notBefore, perAuthor, now),
            timeoutMs,
            () => new HistoryTimeout(),
          ),
        ),
    );
    const lists: TimelineEntry[][] = [];
    let timedOut = false;
    for (const result of settled) {
      if (result.status === 'fulfilled')
        lists.push(
          result.value.map((e) => ({
            ms: e.createdAt.getTime(),
            itemId: sortableId(e.itemId),
          })),
        );
      else if (result.reason instanceof HistoryTimeout) timedOut = true;
      else throw result.reason;
    }
    return { lists, timedOut };
  }

  /**
   * Rebuilds the reader's pushed timeline from the history of `authors` (the followed accounts that are not celebrities).
   * `joined`: another request is rebuilding the same timeline; the caller serves this response by pull.
   */
  async rebuild(userId: string, authors: string[]): Promise<RebuildOutcome> {
    if (!(await this.timelines.acquireRebuild(userId))) {
      feedRebuildCounter.add(1, { outcome: 'joined' });
      return 'joined';
    }
    try {
      const notBefore = new Date(this.clock.nowMs() - REBUILD_DAYS * DAY_MS);
      const { lists, timedOut } = await this.history(
        authors,
        null,
        REBUILD_PER_AUTHOR,
        notBefore,
      );
      const entries = lists.flat();
      await this.timelines.merge(
        userId,
        entries,
        this.config.get('feed_timeline_window'),
      );
      if (!timedOut) await this.timelines.markComplete(userId, !entries.length);
      const outcome = timedOut ? 'incomplete' : 'complete';
      feedRebuildCounter.add(1, { outcome });
      return outcome;
    } catch (error) {
      feedRebuildCounter.add(1, { outcome: 'failed' });
      this.logger.warn(`rebuild failed cause=${(error as Error).name}`);
      throw error;
    } finally {
      await this.timelines.releaseRebuild(userId).catch(() => undefined);
    }
  }

  private gate(): Semaphore {
    const size = this.config.get('feed_rebuild_semaphore');
    if (!this.semaphore || this.semaphore.size !== size)
      this.semaphore = new Semaphore(size);
    return this.semaphore;
  }
}
