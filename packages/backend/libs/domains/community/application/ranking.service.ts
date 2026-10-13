import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TopWindow } from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import { fromSortableId, idTime, sortableId } from '../domain/ids';
import {
  CacheUnavailableError,
  COMMENT_STORE,
  POST_STORE,
  RANK_CACHE,
  type CommentStore,
  type PostRow,
  type PostStore,
  type RankCache,
  type RankedMember,
} from '../domain/ports';
import { previousMonth } from '../domain/months';
import { hotScore, wilsonLowerBound } from '../domain/ranking';
import { isInTopWindow } from '../domain/top-window';
import type { VoteCounts } from '../domain/vote-transition';
import { CountsService } from './counts.service';

export const TOP_WINDOWS: TopWindow[] = ['day', 'week', 'month', 'year', 'all'];

export const hotScope = (boardId: string) => `${boardId}:hot`;
export const topScope = (boardId: string, window: TopWindow) =>
  `${boardId}:top-${window}`;
export const bestScope = (postId: string) => `${postId}:best`;

/** Ranking inputs of a post: weighted votes only (FR-025). */
export const hotOf = (c: VoteCounts, createdAt: Date) =>
  hotScore(c.wups, c.wdowns, createdAt);
export const topOf = (c: VoteCounts) => c.wups - c.wdowns;

/**
 * Board rankings as derived state (S25 D1-D3, FR-035): capped, expiring ZSETs in Redis, rebuilt from the durable store
 * when a ranking is missing. Upkeep on writes touches a ranking only when it exists, so a partial ranking is never
 * mistaken for a complete one. Every method here that touches Redis may raise `CacheUnavailableError`; callers decide
 * whether that degrades a read or is ignored after a committed write.
 */
@Injectable()
export class RankingService {
  private readonly logger = new Logger(RankingService.name);

  constructor(
    @Inject(RANK_CACHE) private readonly rank: RankCache,
    @Inject(POST_STORE) private readonly posts: PostStore,
    @Inject(COMMENT_STORE) private readonly comments: CommentStore,
    private readonly counts: CountsService,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private get cap(): number {
    return this.config.get('discussions_ranking_cap');
  }

  scopesOf(
    boardId: string,
  ): Array<{ scope: string; window: TopWindow | null }> {
    return [
      { scope: hotScope(boardId), window: null },
      ...TOP_WINDOWS.map((w) => ({ scope: topScope(boardId, w), window: w })),
    ];
  }

  /**
   * Rankings this instance could not update because the cache was down. The next read rebuilds them from the durable
   * store, so a post or comment created during an outage is in the ranking once the cache is back (AS-51). Another
   * instance, or a restart, falls back to the expiry of the ranking (6 h).
   */
  private readonly stale = new Set<string>();

  /** Puts a post into every ranking of its board that already exists. */
  async place(
    post: Pick<PostRow, 'postId' | 'boardId' | 'createdAt'>,
    c: VoteCounts,
  ) {
    const member = sortableId(post.postId);
    const now = this.clock.now();
    try {
      for (const { scope, window } of this.scopesOf(post.boardId)) {
        if (!(await this.rank.has(scope))) continue;
        if (window && !isInTopWindow(window, post.createdAt, now)) {
          await this.rank.remove(scope, member);
          continue;
        }
        await this.rank.put(
          scope,
          [{ id: member, score: window ? topOf(c) : hotOf(c, post.createdAt) }],
          this.cap,
        );
      }
    } catch (error) {
      if (error instanceof CacheUnavailableError) this.stale.add(post.boardId);
      throw error;
    }
  }

  async unplace(boardId: string, postId: string): Promise<void> {
    const member = sortableId(postId);
    for (const { scope } of this.scopesOf(boardId))
      await this.rank.remove(scope, member);
  }

  /** Rebuilds every ranking of a board from the durable store (newest posts first, up to the scan cap). */
  async rebuildBoard(boardId: string): Promise<void> {
    const now = this.clock.now();
    const scanCap = this.config.get('discussions_scan_cap');
    const perScope = new Map<string, RankedMember[]>(
      this.scopesOf(boardId).map(({ scope }) => [scope, []]),
    );
    let scanned = 0;
    let bucket: number | null = null;
    scan: while (scanned < scanCap) {
      const months = await this.posts.months(boardId, bucket, 12);
      if (months.length === 0) break;
      for (const month of months) {
        let before: string | null = null;
        for (;;) {
          const page = await this.posts.monthPage(boardId, month, before, 100);
          if (page.length === 0) break;
          before = page[page.length - 1].postId;
          const live = page.filter((e) => !e.deleted && !e.shadow);
          const rows = await this.posts.getMany(live.map((e) => e.postId));
          const votes = await this.counts.voteCountsMany(
            rows.map((r) => r.postId),
          );
          for (const row of rows) {
            if (row.deleted || row.shadow) continue;
            const c = votes.get(row.postId)!;
            const member = sortableId(row.postId);
            for (const { scope, window } of this.scopesOf(boardId)) {
              if (window && !isInTopWindow(window, row.createdAt, now))
                continue;
              perScope.get(scope)!.push({
                id: member,
                score: window ? topOf(c) : hotOf(c, row.createdAt),
              });
            }
          }
          scanned += page.length;
          if (scanned >= scanCap) break scan;
          if (page.length < 100) break;
        }
      }
      bucket = previousMonth(months[months.length - 1]);
    }
    for (const [scope, members] of perScope) {
      await this.rank.drop(scope);
      await this.rank.put(scope, members, this.cap);
    }
  }

  async ensureBoard(boardId: string): Promise<void> {
    if (this.stale.has(boardId) || !(await this.rank.has(hotScope(boardId)))) {
      await this.rebuildBoard(boardId);
      this.stale.delete(boardId);
    }
  }

  /** One keyset page of `scope`, window-filtered, `limit + 1` entries so the caller knows whether more follow. */
  async page(
    scope: string,
    window: TopWindow | null,
    after: { score: number; member: string } | null,
    limit: number,
  ): Promise<RankedMember[]> {
    const now = this.clock.now();
    const out: RankedMember[] = [];
    let cursor = after;
    while (out.length < limit + 1) {
      const want = Math.max(limit + 1, 25);
      const chunk = await this.rank.page(scope, cursor, want);
      for (const m of chunk) {
        cursor = { score: m.score, member: m.id };
        if (window && !isInTopWindow(window, idTime(fromSortableId(m.id)), now))
          continue;
        out.push(m);
        if (out.length >= limit + 1) break;
      }
      if (chunk.length < want) break;
    }
    return out;
  }

  // ---- best comments of a thread (FR-033) ----------------------------------------------------------------------

  /** Adds or re-scores a top-level comment in its thread's `best` ranking, when that ranking exists. */
  async placeRoot(
    postId: string,
    commentId: string,
    c: VoteCounts,
  ): Promise<void> {
    const scope = bestScope(postId);
    try {
      if (!(await this.rank.has(scope))) return;
      await this.rank.put(
        scope,
        [
          {
            id: sortableId(commentId),
            score: wilsonLowerBound(c.wups, c.wdowns),
          },
        ],
        this.cap,
      );
    } catch (error) {
      if (error instanceof CacheUnavailableError)
        this.stale.add(`best:${postId}`);
      throw error;
    }
  }

  /** Rebuilds the `best` ranking of a thread from its top-level comments (all of them, up to the scan cap). */
  async rebuildBest(postId: string): Promise<void> {
    const scanCap = this.config.get('discussions_scan_cap');
    const members: RankedMember[] = [];
    let after: { bucket: number; path: string } | null = null;
    while (members.length < scanCap) {
      const roots = await this.comments.roots(postId, 'asc', after, 200);
      if (roots.length === 0) break;
      after = {
        bucket: roots[roots.length - 1].bucket,
        path: roots[roots.length - 1].path,
      };
      const live = roots.filter((r) => !r.shadow);
      const votes = await this.counts.voteCountsMany(
        live.map((r) => r.commentId),
      );
      for (const r of live) {
        const c = votes.get(r.commentId)!;
        members.push({
          id: sortableId(r.commentId),
          score: wilsonLowerBound(c.wups, c.wdowns),
        });
      }
      if (roots.length < 200) break;
    }
    const scope = bestScope(postId);
    await this.rank.drop(scope);
    await this.rank.put(scope, members, this.cap);
  }

  /** Best order: score descending, then the older comment first (FR-033). Rebuilds a lost ranking first. */
  async bestOrder(postId: string): Promise<RankedMember[]> {
    const scope = bestScope(postId);
    if (this.stale.has(`best:${postId}`) || !(await this.rank.has(scope))) {
      await this.rebuildBest(postId);
      this.stale.delete(`best:${postId}`);
    }
    const all = await this.rank.all(scope);
    return all.sort((a, b) =>
      b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : 1,
    );
  }

  /** Whether the ranking cache answers (used to pick the degraded path without throwing mid-request). */
  async available(): Promise<boolean> {
    try {
      await this.rank.has('probe:hot');
      return true;
    } catch (error) {
      if (error instanceof CacheUnavailableError) return false;
      throw error;
    }
  }
}
