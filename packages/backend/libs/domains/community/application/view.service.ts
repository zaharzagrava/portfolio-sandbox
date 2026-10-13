import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CommentView, PostView } from '@marketplace-sandbox/contracts';
import {
  assertMarkdownComplexity,
  HTML_POLICY_VERSION,
  renderUserMarkdown,
} from '../domain/content';
import {
  COMMENT_STORE,
  POST_STORE,
  VOTE_STORE,
  type CommentRow,
  type CommentStore,
  type PostRow,
  type PostStore,
  type VoteStore,
} from '../domain/ports';
import type { VoteCounts } from '../domain/vote-transition';
import type { Viewer } from './discussion-support';
import { CountsService } from './counts.service';

/** A post the viewer may see (deleted posts only for moderators; shadow posts only for their author). */
export const postVisibleTo = (row: PostRow, viewer: Viewer): boolean =>
  row.deleted
    ? viewer.moderator
    : !row.shadow || (viewer.userId !== null && row.authorId === viewer.userId);

/** A comment the viewer may see (tombstones stay visible, shadow comments only to their author). */
export const commentVisibleTo = (row: CommentRow, viewer: Viewer): boolean =>
  row.deleted ||
  !row.shadow ||
  (viewer.userId !== null && row.authorId === viewer.userId);

/**
 * Turns stored rows into the wire views (S25 A7, B5, FR-041, FR-026): counts from the derived state, `myVote` for
 * the signed-in viewer only, and a rendition re-made from the raw markdown when the stored policy version is old.
 */
@Injectable()
export class ViewService {
  private readonly logger = new Logger(ViewService.name);

  constructor(
    private readonly counts: CountsService,
    @Inject(VOTE_STORE) private readonly votes: VoteStore,
    @Inject(POST_STORE) private readonly posts: PostStore,
    @Inject(COMMENT_STORE) private readonly comments: CommentStore,
  ) {}

  /** The current rendition of a body; a refreshed copy is written back lazily (a failure to do so never fails a read). */
  private rendition(
    markdown: string | null,
    html: string | null,
    version: number | null,
    refresh: (html: string) => Promise<void>,
  ): string {
    if (markdown === null) return '';
    if (version === HTML_POLICY_VERSION) return html ?? '';
    let fresh = '';
    try {
      assertMarkdownComplexity(markdown);
      fresh = renderUserMarkdown(markdown);
    } catch {
      fresh = '';
    }
    refresh(fresh).catch((error: unknown) =>
      this.logger.warn(
        `rendition refresh failed cause=${(error as Error).name}`,
      ),
    );
    return fresh;
  }

  async postViews(rows: PostRow[], viewer: Viewer): Promise<PostView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.postId);
    const [votes, comments, mine] = await Promise.all([
      this.counts.voteCountsMany(ids),
      this.counts.commentCounts(ids),
      viewer.userId
        ? this.votes.viewerVotes(ids, viewer.userId)
        : Promise.resolve(new Map<string, 1 | -1>()),
    ]);
    return rows.map((row) => {
      const c: VoteCounts = votes.get(row.postId)!;
      return {
        postId: row.postId,
        boardId: row.boardId,
        authorId: row.authorId,
        title: row.title,
        bodyHtml: row.deleted
          ? ''
          : this.rendition(row.bodyMd, row.bodyHtml, row.htmlVersion, (html) =>
              this.posts.setRendition(row.postId, html, HTML_POLICY_VERSION),
            ),
        createdAt: row.createdAt.toISOString(),
        ups: c.ups,
        downs: c.downs,
        score: c.ups - c.downs,
        commentCount: comments.get(row.postId) ?? 0,
        myVote: viewer.userId ? (mine.get(row.postId) ?? 0) : null,
      };
    });
  }

  async commentViews(
    rows: CommentRow[],
    viewer: Viewer,
  ): Promise<CommentView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.commentId);
    const [votes, replies, mine] = await Promise.all([
      this.counts.voteCountsMany(ids),
      this.counts.replyCounts(ids),
      viewer.userId
        ? this.votes.viewerVotes(ids, viewer.userId)
        : Promise.resolve(new Map<string, 1 | -1>()),
    ]);
    return rows.map((row) => {
      const c = votes.get(row.commentId)!;
      return {
        commentId: row.commentId,
        postId: row.postId,
        parentId: row.parentId,
        depth: row.depth,
        authorId: row.deleted ? null : row.authorId,
        bodyHtml: row.deleted
          ? ''
          : this.rendition(row.bodyMd, row.bodyHtml, row.htmlVersion, (html) =>
              this.comments.setRendition(row, html, HTML_POLICY_VERSION),
            ),
        createdAt: row.createdAt.toISOString(),
        ups: c.ups,
        downs: c.downs,
        score: c.ups - c.downs,
        myVote: viewer.userId ? (mine.get(row.commentId) ?? 0) : null,
        deleted: row.deleted,
        ...(row.deleted && row.deletedBy ? { deletedBy: row.deletedBy } : {}),
        replyCount: replies.get(row.commentId) ?? 0,
      };
    });
  }
}
