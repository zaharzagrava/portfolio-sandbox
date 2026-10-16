import { Inject, Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import { sortableId } from '../domain/ids';
import { mergeNewestFirst, type TimelineEntry } from '../domain/merge';
import {
  FEED_ITEM_STORE,
  TIMELINE_STORE,
  type FeedItemStore,
  type TimelineStore,
} from '../domain/ports';

const DAY_MS = 86_400_000;

/**
 * The newest items of a celebrity author (S26 C1, C2): a bounded list (`fd:cel`, 200 entries, 24 h) that fan-out feeds
 * and every follower's read merges. The list is a cache of the durable per-author history: when it is absent (expired,
 * or every `fd:` key lost) it is rebuilt from history, so nothing is missed (AS-28). A list is only ever created by a
 * rebuild, never by a bare push, so it can not hold a partial set.
 */
@Injectable()
export class CelebrityRecentsService {
  constructor(
    @Inject(TIMELINE_STORE) private readonly timelines: TimelineStore,
    @Inject(FEED_ITEM_STORE) private readonly items: FeedItemStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ApiConfigService,
  ) {}

  /** Records a new item (stored before it was announced) in the author's recents. */
  async record(authorId: string, entry: TimelineEntry): Promise<void> {
    const cap = this.config.get('feed_celebrity_recents');
    await this.timelines.pushRecent(authorId, entry, cap);
    if ((await this.timelines.recents(authorId, null, 1)) === null)
      await this.rebuild(authorId);
  }

  /** Up to `limit` recents strictly older than `before`, newest first. */
  async read(
    authorId: string,
    before: TimelineEntry | null,
    limit: number,
  ): Promise<TimelineEntry[]> {
    const found = await this.timelines.recents(authorId, before, limit);
    if (found !== null) return found;
    const all = await this.rebuild(authorId);
    return mergeNewestFirst([all], limit, before ?? undefined);
  }

  /** Rebuilds the list from the durable history; returns the entries now in it. */
  async rebuild(authorId: string): Promise<TimelineEntry[]> {
    const cap = this.config.get('feed_celebrity_recents');
    const now = this.clock.now();
    const notBefore = new Date(
      now.getTime() - this.config.get('feed_retention_days') * DAY_MS,
    );
    const history = await this.items.authorHistory(
      authorId,
      null,
      notBefore,
      cap,
      now,
    );
    const entries = history.map((e) => ({
      ms: e.createdAt.getTime(),
      itemId: sortableId(e.itemId),
    }));
    await this.timelines.putRecents(authorId, entries, cap);
    return entries;
  }
}
