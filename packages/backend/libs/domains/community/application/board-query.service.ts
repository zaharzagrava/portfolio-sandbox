import { Inject, Injectable } from '@nestjs/common';
import type {
  BoardSort,
  PostPage,
  PostView,
  TopWindow,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import type { CursorCodec } from '../domain/cursor';
import { invalidCursor } from '../domain/discussion-errors';
import { fromSortableId, idTime, sortableId } from '../domain/ids';
import { previousMonth } from '../domain/months';
import {
  CacheUnavailableError,
  CURSOR_CODEC,
  POST_STORE,
  type PostRow,
  type PostStore,
  type RankedMember,
} from '../domain/ports';
import { isInTopWindow } from '../domain/top-window';
import { discussionDegradedCounter } from '../domain/discussions-metrics';
import { CountsService } from './counts.service';
import type { Viewer } from './discussion-support';
import {
  hotOf,
  hotScope,
  RankingService,
  topOf,
  topScope,
} from './ranking.service';
import { ViewService } from './view.service';

export interface BoardListQuery {
  boardId: string;
  sort: BoardSort;
  window: TopWindow;
  limit: number;
  cursor: string | null;
}

/**
 * Board lists (S25 US4): `hot` and `top` from capped rankings with keyset cursors, `new` by walking the board's
 * non-empty months, everything hydrated in batches. With the ranking cache down, `hot` and `top` are computed from
 * the newest posts of the durable store and flagged `degraded` (AS-51).
 */
@Injectable()
export class BoardQueryService {
  constructor(
    @Inject(POST_STORE) private readonly posts: PostStore,
    @Inject(CURSOR_CODEC) private readonly cursors: CursorCodec,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly ranking: RankingService,
    private readonly counts: CountsService,
    private readonly views: ViewService,
    private readonly config: ApiConfigService,
  ) {}

  async list(query: BoardListQuery, viewer: Viewer): Promise<PostPage> {
    return query.sort === 'new'
      ? this.listNew(query, viewer)
      : this.listRanked(query, viewer);
  }

  // ---- hot and top -----------------------------------------------------------------------------------------------

  private scopeOf(query: BoardListQuery): string {
    return query.sort === 'hot'
      ? hotScope(query.boardId)
      : topScope(query.boardId, query.window);
  }

  private async listRanked(
    query: BoardListQuery,
    viewer: Viewer,
  ): Promise<PostPage> {
    const kind = query.sort;
    const scope = `${query.boardId}:${query.sort}:${query.sort === 'top' ? query.window : '-'}`;
    const position =
      query.cursor === null
        ? null
        : this.cursors.decode(query.cursor, { kind, scope });
    if (query.cursor !== null && position === null) throw invalidCursor();
    let after: { score: number; member: string } | null = null;
    if (position !== null) {
      const sep = position.indexOf('|');
      const score = Number(position.slice(0, sep));
      if (sep < 0 || Number.isNaN(score)) throw invalidCursor();
      after = { score, member: position.slice(sep + 1) };
    }

    let ordered: RankedMember[];
    let degraded = false;
    try {
      await this.ranking.ensureBoard(query.boardId);
      ordered = await this.ranking.page(
        this.scopeOf(query),
        query.sort === 'top' ? query.window : null,
        after,
        query.limit,
      );
    } catch (error) {
      if (!(error instanceof CacheUnavailableError)) throw error;
      degraded = true;
      discussionDegradedCounter.add(1, { list: 'board' });
      ordered = await this.degraded(query, after);
    }

    const more = ordered.length > query.limit;
    const members = ordered.slice(0, query.limit);
    const rows = await this.posts.getMany(
      members.map((m) => fromSortableId(m.id)),
    );
    const byId = new Map(rows.map((r) => [r.postId, r]));
    const live: PostRow[] = [];
    const liveMembers: RankedMember[] = [];
    for (const m of members) {
      const row = byId.get(fromSortableId(m.id));
      if (row && !row.deleted && !row.shadow) {
        live.push(row);
        liveMembers.push(m);
      }
    }
    const items = await this.views.postViews(live, viewer);
    const last = members[members.length - 1];
    return {
      items,
      nextCursor:
        more && last
          ? this.cursors.encode({
              kind,
              scope,
              position: `${last.score}|${last.id}`,
            })
          : null,
      ...(degraded ? { degraded: true as const } : {}),
    };
  }

  /** The newest posts of the board ranked in memory from exact counts (cache down). One extra entry marks "more". */
  private async degraded(
    query: BoardListQuery,
    after: { score: number; member: string } | null,
  ): Promise<RankedMember[]> {
    const window = this.config.get('discussions_degraded_window');
    const now = this.clock.now();
    const rows: PostRow[] = [];
    let bucket: number | null = null;
    while (rows.length < window) {
      const months = await this.posts.months(query.boardId, bucket, 6);
      if (months.length === 0) break;
      for (const month of months) {
        let before: string | null = null;
        while (rows.length < window) {
          const page = await this.posts.monthPage(
            query.boardId,
            month,
            before,
            window,
          );
          if (page.length === 0) break;
          before = page[page.length - 1].postId;
          const live = page.filter((e) => !e.deleted && !e.shadow);
          rows.push(...(await this.posts.getMany(live.map((e) => e.postId))));
          if (page.length < window) break;
        }
      }
      bucket = previousMonth(months[months.length - 1]);
    }
    const votes = await this.counts.voteCountsMany(rows.map((r) => r.postId));
    const ranked = rows
      .filter(
        (r) =>
          !r.deleted &&
          !r.shadow &&
          (query.sort === 'hot' ||
            isInTopWindow(query.window, r.createdAt, now)),
      )
      .map((r) => {
        const c = votes.get(r.postId)!;
        return {
          id: sortableId(r.postId),
          score: query.sort === 'hot' ? hotOf(c, r.createdAt) : topOf(c),
        };
      })
      .sort((a, b) =>
        b.score !== a.score ? b.score - a.score : a.id < b.id ? 1 : -1,
      );
    const start = after
      ? ranked.findIndex(
          (m) =>
            m.score < after.score ||
            (m.score === after.score && m.id < after.member),
        )
      : 0;
    return start < 0 ? [] : ranked.slice(start, start + query.limit + 1);
  }

  // ---- new -------------------------------------------------------------------------------------------------------

  private async listNew(
    query: BoardListQuery,
    viewer: Viewer,
  ): Promise<PostPage> {
    const scope = `${query.boardId}:new`;
    const position =
      query.cursor === null
        ? null
        : this.cursors.decode(query.cursor, { kind: 'new', scope });
    if (query.cursor !== null && position === null) throw invalidCursor();
    let bucket: number | null = null;
    let before: string | null = null;
    if (position !== null) {
      const sep = position.indexOf('|');
      bucket = Number(position.slice(0, sep));
      before = position.slice(sep + 1);
      if (sep < 0 || !Number.isInteger(bucket) || !before)
        throw invalidCursor();
    }

    const found: Array<{ postId: string; bucket: number }> = [];
    const need = query.limit + 1;
    scan: while (found.length < need) {
      const months = await this.posts.months(query.boardId, bucket, 12);
      if (months.length === 0) break;
      for (const month of months) {
        // the cursor's month resumes after the cursor; later months start from their newest post
        let resume: string | null = month === bucket ? before : null;
        for (;;) {
          const page = await this.posts.monthPage(
            query.boardId,
            month,
            resume,
            need,
          );
          for (const e of page) {
            const mine = viewer.userId !== null && e.authorId === viewer.userId;
            if (!e.deleted && (!e.shadow || mine))
              found.push({ postId: e.postId, bucket: month });
            if (found.length >= need) break scan;
          }
          if (page.length < need) break;
          resume = page[page.length - 1].postId;
        }
      }
      bucket = previousMonth(months[months.length - 1]);
      before = null;
    }

    const more = found.length > query.limit;
    const page = found.slice(0, query.limit);
    const rows = await this.posts.getMany(page.map((p) => p.postId));
    const byId = new Map(rows.map((r) => [r.postId, r]));
    const ordered = page
      .map((p) => byId.get(p.postId))
      .filter((r): r is PostRow => !!r && !r.deleted);
    const items: PostView[] = await this.views.postViews(ordered, viewer);
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        more && last
          ? this.cursors.encode({
              kind: 'new',
              scope,
              position: `${last.bucket}|${last.postId}`,
            })
          : null,
    };
  }

  /** Creation time of a ranking member (used by specs and reconcile). */
  static memberTime(member: string): Date {
    return idTime(fromSortableId(member));
  }
}
