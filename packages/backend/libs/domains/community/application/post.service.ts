import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PostView } from '@marketplace-sandbox/contracts';
import {
  assertMarkdownComplexity,
  HTML_POLICY_VERSION,
  MarkdownTooComplexError,
  normalizeTitle,
  renderUserMarkdown,
} from '../domain/content';
import {
  DiscussionPostCreated,
  DiscussionPostDeleted,
} from '../domain/discussion-events';
import {
  forbidden,
  markdownTooComplex,
  postNotFound,
  validationFailed,
} from '../domain/discussion-errors';
import { discussionWriteCounter } from '../domain/discussions-metrics';
import { idTime } from '../domain/ids';
import {
  BOARD_GATE,
  CacheUnavailableError,
  CLAIM_STORE,
  POST_STORE,
  SHADOW_STORE,
  type BoardGate,
  type ClaimStore,
  type DeletedBy,
  type PostRow,
  type PostStore,
  type ShadowStore,
} from '../domain/ports';
import { CountsService, swallowCache } from './counts.service';
import {
  DiscussionIds,
  keyHash,
  recordEvent,
  type Viewer,
} from './discussion-support';
import { RankingService } from './ranking.service';
import { postVisibleTo, ViewService } from './view.service';

export interface CreatePostInput {
  userId: string;
  boardId: string;
  title: unknown;
  body: unknown;
  idempotencyKey: string;
}

/**
 * Posts (S25 US1): create (board gate, creation claim, one logged batch holding the post, its index rows and the
 * recorded event), read, delete. The post exists if and only if its event will be published (R-3).
 */
@Injectable()
export class PostService {
  private readonly logger = new Logger(PostService.name);

  constructor(
    @Inject(POST_STORE) private readonly posts: PostStore,
    @Inject(CLAIM_STORE) private readonly claims: ClaimStore,
    @Inject(BOARD_GATE) private readonly gate: BoardGate,
    @Inject(SHADOW_STORE) private readonly shadow: ShadowStore,
    private readonly ids: DiscussionIds,
    private readonly counts: CountsService,
    private readonly ranking: RankingService,
    private readonly views: ViewService,
  ) {}

  async create(input: CreatePostInput): Promise<PostView> {
    const title = normalizeTitle(input.title);
    const body = input.body === undefined ? '' : input.body;
    const fields: string[] = [];
    if (title === null) fields.push('title');
    if (typeof body !== 'string' || [...body].length > 40_000)
      fields.push('body');
    if (fields.length > 0) throw validationFailed(fields);
    try {
      assertMarkdownComplexity(body as string);
    } catch (error) {
      if (error instanceof MarkdownTooComplexError) throw markdownTooComplex();
      throw error;
    }

    await this.gate.assertOpen(input.boardId);
    const shadow = await this.shadow.isBanned(input.userId);
    const fresh = this.ids.next();
    const claim = await this.claims.claim(
      input.userId,
      keyHash(input.idempotencyKey),
      'post',
      fresh.id,
      '',
      fresh.createdAt,
    );
    const postId = claim.entityId;
    const createdAt = claim.claimed ? fresh.createdAt : idTime(postId);

    const row: PostRow = {
      postId,
      boardId: input.boardId.toLowerCase(),
      authorId: input.userId,
      title: title!,
      bodyMd: body as string,
      bodyHtml: renderUserMarkdown(body as string),
      htmlVersion: HTML_POLICY_VERSION,
      createdAt,
      deleted: false,
      deletedBy: null,
      shadow,
    };
    const event = shadow
      ? null
      : recordEvent(
          DiscussionPostCreated,
          postId,
          {
            postId,
            boardId: row.boardId,
            authorId: row.authorId,
            title: row.title,
            createdAt: createdAt.toISOString(),
          },
          createdAt,
        );
    await this.posts.insert(row, event);
    discussionWriteCounter.add(1, {
      kind: 'post',
      outcome: claim.claimed ? 'created' : 'replayed',
    });

    if (!shadow) {
      await this.counts.seedVotes(postId);
      await this.ranking
        .place(row, { ups: 0, downs: 0, wups: 0, wdowns: 0 })
        .catch(swallowCache);
    }
    const [view] = await this.views.postViews([row], {
      userId: input.userId,
      moderator: false,
    });
    return view;
  }

  async get(postId: string, viewer: Viewer): Promise<PostView> {
    const row = await this.posts.get(postId);
    if (!row || !postVisibleTo(row, viewer)) throw postNotFound();
    const [view] = await this.views.postViews([row], viewer);
    return view;
  }

  /** Deletes a post (author, `ADMIN` or `MODERATOR`); repeating it is a no-op and records no second event. */
  async delete(postId: string, viewer: Viewer): Promise<void> {
    if (!viewer.userId) throw forbidden();
    const row = await this.posts.get(postId);
    if (!row) throw postNotFound();
    const isAuthor = row.authorId === viewer.userId;
    if (row.deleted) {
      if (isAuthor || viewer.moderator) return;
      throw postNotFound();
    }
    if (!isAuthor && !viewer.moderator) {
      if (row.shadow) throw postNotFound();
      throw forbidden();
    }
    const by: DeletedBy = isAuthor ? 'author' : 'moderator';
    const at = this.ids.now();
    const event = row.shadow
      ? null
      : recordEvent(
          DiscussionPostDeleted,
          postId,
          { postId, boardId: row.boardId, deletedBy: by },
          at,
        );
    const applied = await this.posts.tombstone(row, by, event);
    if (applied)
      discussionWriteCounter.add(1, {
        kind: 'post_delete',
        outcome: 'created',
      });
    if (applied)
      await this.ranking.unplace(row.boardId, postId).catch((error) => {
        if (!(error instanceof CacheUnavailableError)) throw error;
        this.logger.warn('ranking cleanup deferred: cache unavailable');
      });
  }
}
