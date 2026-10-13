import { Inject, Injectable } from '@nestjs/common';
import type {
  CommentNode,
  CommentRepliesPage,
  CommentThreadPage,
  CommentView,
  ThreadSort,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  assertMarkdownComplexity,
  HTML_POLICY_VERSION,
  MarkdownTooComplexError,
  plainTextPreview,
  renderUserMarkdown,
} from '../domain/content';
import type { CursorCodec } from '../domain/cursor';
import {
  commentNotFound,
  forbidden,
  invalidCursor,
  markdownTooComplex,
  maxDepthExceeded,
  parentDeleted,
  parentNotFound,
  postNotFound,
  validationFailed,
} from '../domain/discussion-errors';
import {
  DiscussionCommentCreated,
  DiscussionCommentDeleted,
} from '../domain/discussion-events';
import { discussionWriteCounter } from '../domain/discussions-metrics';
import { fromSortableId, idTime, isTimeUuid, sortableId } from '../domain/ids';
import { dayOf } from '../domain/months';
import { MAX_DEPTH, pathFor, rootPathOf } from '../domain/paths';
import {
  BOARD_GATE,
  CacheUnavailableError,
  CLAIM_STORE,
  COMMENT_STORE,
  CURSOR_CODEC,
  PAGE_CACHE,
  POST_STORE,
  SHADOW_STORE,
  VOTE_STORE,
  type BoardGate,
  type ClaimStore,
  type CommentRow,
  type CommentStore,
  type DeletedBy,
  type PageCache,
  type PostStore,
  type RankedMember,
  type ShadowStore,
  type ThreadRoot,
  type VoteStore,
} from '../domain/ports';
import { wilsonLowerBound } from '../domain/ranking';
import { CountsService, swallowCache } from './counts.service';
import {
  ANONYMOUS,
  DiscussionIds,
  keyHash,
  recordEvent,
  type Viewer,
} from './discussion-support';
import { RankingService } from './ranking.service';
import { commentVisibleTo, postVisibleTo, ViewService } from './view.service';

export interface CreateCommentInput {
  userId: string;
  postId: string;
  body: unknown;
  parentId?: string;
  idempotencyKey: string;
}

export interface ThreadQuery {
  postId: string;
  sort: ThreadSort;
  limit: number;
  cursor: string | null;
}

interface CachedPage {
  fetchedAt: number;
  page: CommentThreadPage;
}

const visibleRoot = (r: ThreadRoot, viewer: Viewer): boolean =>
  !r.shadow || (viewer.userId !== null && r.authorId === viewer.userId);

/**
 * Comments (S25 US2, US5): atomic create (reply rules, partition slot, claim, one logged batch), tombstone delete,
 * paged threads (top-level comments paged, each with its first replies) and the per-branch replies endpoint.
 */
@Injectable()
export class CommentService {
  constructor(
    @Inject(POST_STORE) private readonly posts: PostStore,
    @Inject(COMMENT_STORE) private readonly comments: CommentStore,
    @Inject(CLAIM_STORE) private readonly claims: ClaimStore,
    @Inject(BOARD_GATE) private readonly gate: BoardGate,
    @Inject(SHADOW_STORE) private readonly shadow: ShadowStore,
    @Inject(PAGE_CACHE) private readonly pages: PageCache,
    @Inject(VOTE_STORE) private readonly votes: VoteStore,
    @Inject(CURSOR_CODEC) private readonly cursors: CursorCodec,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly ids: DiscussionIds,
    private readonly counts: CountsService,
    private readonly ranking: RankingService,
    private readonly views: ViewService,
    private readonly config: ApiConfigService,
  ) {}

  private get embedded(): number {
    return this.config.get('discussions_replies_embedded');
  }

  // ---- create ----------------------------------------------------------------------------------------------------

  async create(input: CreateCommentInput): Promise<CommentView> {
    const body = typeof input.body === 'string' ? input.body.trim() : null;
    if (body === null || [...body].length < 1 || [...body].length > 10_000)
      throw validationFailed(['body']);
    try {
      assertMarkdownComplexity(body);
    } catch (error) {
      if (error instanceof MarkdownTooComplexError) throw markdownTooComplex();
      throw error;
    }

    const viewer: Viewer = { userId: input.userId, moderator: false };
    const post = await this.posts.get(input.postId);
    if (!post || !postVisibleTo(post, viewer)) throw postNotFound();
    await this.gate.assertOpen(post.boardId);

    let parent: CommentRow | null = null;
    if (input.parentId) {
      const loc = await this.comments.getLocator(input.parentId);
      if (!loc || loc.postId !== post.postId) throw parentNotFound();
      const row = await this.comments.getRow(loc.postId, loc.bucket, loc.path);
      if (!row || !commentVisibleTo(row, viewer)) throw parentNotFound();
      if (row.deleted) throw parentDeleted();
      if (row.depth >= MAX_DEPTH) throw maxDepthExceeded();
      parent = row;
    }

    const shadow = await this.shadow.isBanned(input.userId);
    const fresh = this.ids.next();
    const depth = parent ? parent.depth + 1 : 0;
    // A root takes the next slot of the post's partitions; a reply lives in its root's bucket.
    const freshBucket =
      parent?.bucket ??
      (await this.comments.allocateRootBucket(
        post.postId,
        this.config.get('discussions_partition_size'),
      ));
    const claim = await this.claims.claim(
      input.userId,
      keyHash(input.idempotencyKey),
      'comment',
      fresh.id,
      String(freshBucket),
      fresh.createdAt,
    );
    const commentId = claim.entityId;
    const createdAt = claim.claimed ? fresh.createdAt : idTime(commentId);
    const bucket = claim.claimed ? freshBucket : Number(claim.note);
    const path = pathFor(parent?.path ?? null, commentId);

    const row: CommentRow = {
      commentId,
      postId: post.postId,
      bucket,
      path,
      parentId: input.parentId ?? null,
      depth,
      authorId: input.userId,
      bodyMd: body,
      bodyHtml: renderUserMarkdown(body),
      htmlVersion: HTML_POLICY_VERSION,
      createdAt,
      deleted: false,
      deletedBy: null,
      shadow,
      moreReplies: false,
    };
    const event = shadow
      ? null
      : recordEvent(
          DiscussionCommentCreated,
          post.postId,
          {
            commentId,
            postId: post.postId,
            boardId: post.boardId,
            authorId: input.userId,
            parentCommentId: input.parentId ?? null,
            parentAuthorId: parent?.authorId ?? null,
            postAuthorId: post.authorId,
            preview: plainTextPreview(body),
            createdAt: createdAt.toISOString(),
          },
          createdAt,
        );
    await this.comments.insert(row, input.userId, event, dayOf(createdAt));
    discussionWriteCounter.add(1, {
      kind: 'comment',
      outcome: claim.claimed ? 'created' : 'replayed',
    });

    if (!shadow) {
      await this.counts.bumpComments(post.postId, input.parentId ?? null, 1);
      await this.counts.seedVotes(commentId);
      if (depth === 0)
        await this.ranking
          .placeRoot(post.postId, commentId, {
            ups: 0,
            downs: 0,
            wups: 0,
            wdowns: 0,
          })
          .catch(swallowCache);
    }
    if (depth > 0) await this.flagMoreReplies(row);
    await this.dropPages(post.postId);

    const [view] = await this.views.commentViews([row], viewer);
    return view;
  }

  /** Sets the root's "more replies" flag once its subtree outgrows the embedded first page (never cleared). */
  private async flagMoreReplies(row: CommentRow): Promise<void> {
    const rootPath = rootPathOf(row.path);
    const rows = await this.comments.subtree(
      row.postId,
      row.bucket,
      rootPath,
      rootPath,
      true,
      this.embedded + 2,
    );
    if (rows.length >= this.embedded + 2)
      await this.comments.markMoreReplies(row.postId, row.bucket, rootPath);
  }

  // ---- delete ----------------------------------------------------------------------------------------------------

  async delete(commentId: string, viewer: Viewer): Promise<void> {
    if (!viewer.userId) throw forbidden();
    const loc = isTimeUuid(commentId)
      ? await this.comments.getLocator(commentId)
      : null;
    if (!loc) throw commentNotFound();
    const row = await this.comments.getRow(loc.postId, loc.bucket, loc.path);
    if (!row) throw commentNotFound();
    if (row.deleted) return; // idempotent: a tombstone no longer names its author
    const isAuthor = row.authorId === viewer.userId;
    if (!isAuthor && !viewer.moderator) {
      if (row.shadow) throw commentNotFound();
      throw forbidden();
    }
    const post = await this.posts.get(row.postId);
    if (!post) throw commentNotFound();
    const by: DeletedBy = isAuthor ? 'author' : 'moderator';
    const event = row.shadow
      ? null
      : recordEvent(
          DiscussionCommentDeleted,
          row.postId,
          {
            commentId,
            postId: row.postId,
            boardId: post.boardId,
            deletedBy: by,
          },
          this.ids.now(),
        );
    const applied = await this.comments.tombstone(row, by, event);
    if (!applied) return;
    discussionWriteCounter.add(1, {
      kind: 'comment_delete',
      outcome: 'created',
    });
    if (!row.shadow)
      await this.counts.bumpComments(row.postId, row.parentId, -1);
    await this.dropPages(row.postId);
  }

  // ---- thread ----------------------------------------------------------------------------------------------------

  async thread(query: ThreadQuery, viewer: Viewer): Promise<CommentThreadPage> {
    const post = await this.posts.get(query.postId);
    if (!post || !postVisibleTo(post, viewer)) throw postNotFound();

    const banned = viewer.userId
      ? await this.shadow.isBanned(viewer.userId)
      : false;
    const cacheable =
      query.cursor === null &&
      !banned &&
      query.limit === this.config.get('discussions_page_default');
    if (!cacheable) return this.buildPage(query, viewer);

    // The shared first page holds no viewer data: it is built for an anonymous reader and each request merges in its
    // own votes (FR-036).
    const key = `${query.postId}:${query.sort}`;
    const cached = await this.readCached(key);
    if (cached) return this.withViewer(cached, viewer);
    const page = await this.buildPage(query, ANONYMOUS);
    await this.writeCached(key, page);
    return this.withViewer(page, viewer);
  }

  /**
   * Threads whose cached first page could not be dropped by a write because the cache was down. Until a drop
   * succeeds this instance does not serve its cached copy; other instances rely on the 5-second expiry.
   */
  private readonly stalePages = new Set<string>();

  /** Drops every cached page of a thread after a write; remembers the thread when the cache cannot be reached. */
  private async dropPages(postId: string): Promise<void> {
    try {
      await this.pages.drop(postId);
      this.stalePages.delete(postId);
    } catch (error) {
      if (!(error instanceof CacheUnavailableError)) throw error;
      this.stalePages.add(postId);
    }
  }

  private async readCached(key: string): Promise<CommentThreadPage | null> {
    const postId = key.slice(0, key.indexOf(':'));
    if (this.stalePages.has(postId)) {
      await this.dropPages(postId);
      if (this.stalePages.has(postId)) return null;
    }
    try {
      const raw = await this.pages.get(key);
      if (!raw) return null;
      const cached = JSON.parse(raw) as CachedPage;
      const ageMs = this.clock.nowMs() - cached.fetchedAt;
      return ageMs >= 0 &&
        ageMs < this.config.get('discussions_page_cache_seconds') * 1000
        ? cached.page
        : null;
    } catch (error) {
      if (error instanceof CacheUnavailableError) return null;
      throw error;
    }
  }

  private async writeCached(
    key: string,
    page: CommentThreadPage,
  ): Promise<void> {
    if (page.degraded) return;
    const payload: CachedPage = { fetchedAt: this.clock.nowMs(), page };
    await this.pages
      .set(
        key,
        JSON.stringify(payload),
        this.config.get('discussions_page_cache_seconds'),
      )
      .catch(swallowCache);
  }

  /** A cached (viewer-independent) page with this viewer's own votes merged in. */
  private async withViewer(
    page: CommentThreadPage,
    viewer: Viewer,
  ): Promise<CommentThreadPage> {
    if (!viewer.userId) return page;
    const ids = page.items.flatMap((n) => [
      n.commentId,
      ...n.replies.map((r) => r.commentId),
    ]);
    const mine = await this.votes.viewerVotes(ids, viewer.userId);
    return {
      ...page,
      items: page.items.map((n) => ({
        ...n,
        myVote: mine.get(n.commentId) ?? 0,
        replies: n.replies.map((r) => ({
          ...r,
          myVote: mine.get(r.commentId) ?? 0,
        })),
      })),
    };
  }

  private async buildPage(
    query: ThreadQuery,
    viewer: Viewer,
  ): Promise<CommentThreadPage> {
    const scope = query.postId;
    const kind =
      query.sort === 'best' ? 'best' : query.sort === 'new' ? 'new' : 'old';
    const position =
      query.cursor === null
        ? null
        : this.cursors.decode(query.cursor, { kind, scope });
    if (query.cursor !== null && position === null) throw invalidCursor();

    let roots: ThreadRoot[];
    let more: boolean;
    let positionOf: (last: ThreadRoot) => string;
    let degraded = false;

    if (query.sort === 'best') {
      const picked = await this.pickBest(query, position, viewer);
      roots = picked.roots;
      more = picked.more;
      degraded = picked.degraded;
      const memberOf = new Map(picked.members.map((m) => [m.id, m]));
      positionOf = (last) => {
        const m = memberOf.get(sortableId(last.commentId))!;
        return `${m.score}|${m.id}`;
      };
    } else {
      const direction = query.sort === 'new' ? 'desc' : 'asc';
      let cursor: { bucket: number; path: string } | null = null;
      if (position !== null) {
        const sep = position.indexOf('|');
        const bucket = Number(position.slice(0, sep));
        if (sep < 0 || !Number.isInteger(bucket)) throw invalidCursor();
        cursor = { bucket, path: position.slice(sep + 1) };
      }
      const found: ThreadRoot[] = [];
      for (;;) {
        const need = query.limit + 1 - found.length;
        const chunk = await this.comments.roots(
          query.postId,
          direction,
          cursor,
          need,
        );
        for (const r of chunk) if (visibleRoot(r, viewer)) found.push(r);
        if (chunk.length < need || found.length >= query.limit + 1) break;
        const last = chunk[chunk.length - 1];
        cursor = { bucket: last.bucket, path: last.path };
      }
      more = found.length > query.limit;
      roots = found.slice(0, query.limit);
      positionOf = (last) => `${last.bucket}|${last.path}`;
    }

    const items = await this.assemble(query.postId, roots, viewer);
    return {
      items,
      nextCursor:
        more && roots.length > 0
          ? this.cursors.encode({
              kind,
              scope,
              position: positionOf(roots[roots.length - 1]),
            })
          : null,
      ...(degraded ? { degraded: true as const } : {}),
    };
  }

  /** `best` order from the ranking cache; newest top-level comments from the store when the cache is down. */
  private async pickBest(
    query: ThreadQuery,
    position: string | null,
    viewer: Viewer,
  ): Promise<{
    roots: ThreadRoot[];
    more: boolean;
    members: RankedMember[];
    degraded: boolean;
  }> {
    let ordered: RankedMember[];
    let degraded = false;
    try {
      ordered = await this.ranking.bestOrder(query.postId);
    } catch (error) {
      if (!(error instanceof CacheUnavailableError)) throw error;
      degraded = true;
      ordered = await this.degradedBest(query.postId);
    }
    let index = 0;
    if (position !== null) {
      const sep = position.indexOf('|');
      const score = Number(position.slice(0, sep));
      const member = position.slice(sep + 1);
      if (sep < 0 || Number.isNaN(score)) throw invalidCursor();
      index = ordered.findIndex(
        (m) => m.score < score || (m.score === score && m.id > member),
      );
      if (index < 0) index = ordered.length;
    }
    const resolved: ThreadRoot[] = [];
    const members: RankedMember[] = [];
    while (resolved.length < query.limit + 1 && index < ordered.length) {
      const batch = ordered.slice(
        index,
        index + (query.limit + 1 - resolved.length),
      );
      index += batch.length;
      const located = await Promise.all(
        batch.map((m) => this.comments.getLocator(fromSortableId(m.id))),
      );
      const rows = await Promise.all(
        located.map((loc) =>
          loc
            ? this.comments.getRow(loc.postId, loc.bucket, loc.path)
            : Promise.resolve(null),
        ),
      );
      batch.forEach((m, i) => {
        const row = rows[i];
        if (!row || !commentVisibleTo(row, viewer)) return;
        resolved.push({
          bucket: row.bucket,
          path: row.path,
          commentId: row.commentId,
          shadow: row.shadow,
          deleted: row.deleted,
          authorId: row.authorId,
        });
        members.push(m);
      });
    }
    return {
      roots: resolved.slice(0, query.limit),
      more: resolved.length > query.limit,
      members,
      degraded,
    };
  }

  /** The newest top-level comments, ranked in memory from exact counts (cache down, degraded mode, AS-51). */
  private async degradedBest(postId: string): Promise<RankedMember[]> {
    const window = this.config.get('discussions_degraded_window');
    const roots = (
      await this.comments.roots(postId, 'desc', null, window)
    ).filter((r) => !r.shadow);
    const votes = await this.counts.voteCountsMany(
      roots.map((r) => r.commentId),
    );
    return roots
      .map((r) => {
        const c = votes.get(r.commentId)!;
        return {
          id: sortableId(r.commentId),
          score: wilsonLowerBound(c.wups, c.wdowns),
        };
      })
      .sort((a, b) =>
        b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : 1,
      );
  }

  /** Root rows with their first replies, as nodes in `roots` order (one range read per root). */
  private async assemble(
    postId: string,
    roots: ThreadRoot[],
    viewer: Viewer,
  ): Promise<CommentNode[]> {
    const groups = await Promise.all(
      roots.map((r) =>
        this.comments.subtree(
          postId,
          r.bucket,
          r.path,
          r.path,
          true,
          this.embedded + 1,
        ),
      ),
    );
    const flat: CommentRow[] = [];
    const shape: Array<{ root: CommentRow; replies: CommentRow[] }> = [];
    groups.forEach((rows, i) => {
      const root = rows.find((r) => r.path === roots[i].path);
      if (!root) return;
      const replies = rows
        .filter((r) => r.path !== root.path)
        .filter((r) => commentVisibleTo(r, viewer));
      shape.push({ root, replies });
      flat.push(root, ...replies);
    });
    const views = await this.views.commentViews(flat, viewer);
    const byId = new Map(views.map((v) => [v.commentId, v]));
    return shape.map(({ root, replies }) => ({
      ...byId.get(root.commentId)!,
      replies: replies.map((r) => byId.get(r.commentId)!),
      hasMoreReplies: root.moreReplies,
    }));
  }

  // ---- replies of one branch -------------------------------------------------------------------------------------

  async replies(
    commentId: string,
    limit: number,
    cursor: string | null,
    viewer: Viewer,
  ): Promise<CommentRepliesPage> {
    const loc = isTimeUuid(commentId)
      ? await this.comments.getLocator(commentId)
      : null;
    if (!loc) throw commentNotFound();
    const row = await this.comments.getRow(loc.postId, loc.bucket, loc.path);
    if (!row || !commentVisibleTo(row, viewer)) throw commentNotFound();
    const post = await this.posts.get(row.postId);
    if (!post || !postVisibleTo(post, viewer)) throw commentNotFound();

    const scope = commentId;
    const resume =
      cursor === null
        ? null
        : this.cursors.decode(cursor, { kind: 'replies', scope });
    if (cursor !== null && resume === null) throw invalidCursor();

    // The first page of a top-level comment starts after the replies already embedded in the thread.
    const skip = cursor === null && loc.depth === 0 ? this.embedded : 0;
    const visible: CommentRow[] = [];
    let from = resume ?? loc.path;
    let skipped = 0;
    for (;;) {
      const need = skip - skipped + limit + 1 - visible.length;
      const chunk = await this.comments.subtree(
        loc.postId,
        loc.bucket,
        loc.path,
        from,
        false,
        need,
      );
      if (chunk.length === 0) break;
      from = chunk[chunk.length - 1].path;
      for (const r of chunk) {
        if (skipped < skip) skipped++;
        else if (commentVisibleTo(r, viewer)) visible.push(r);
      }
      if (chunk.length < need || visible.length >= limit + 1) break;
    }
    const page = visible.slice(0, limit);
    return {
      items: await this.views.commentViews(page, viewer),
      nextCursor:
        visible.length > limit
          ? this.cursors.encode({
              kind: 'replies',
              scope,
              position: page[page.length - 1].path,
            })
          : null,
    };
  }
}
