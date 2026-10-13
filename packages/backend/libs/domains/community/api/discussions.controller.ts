import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type {
  BoardSort,
  CommentRepliesPage,
  CommentThreadPage,
  CommentView,
  PostPage,
  PostView,
  ThreadSort,
  TopWindow,
  VoteResult,
} from '@marketplace-sandbox/contracts';
import { Firewall, Role, User, UserRawDto } from '@app/domains/identity';
import { Idempotent } from '@app/infrastructure/idempotency';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { BoardQueryService } from '../application/board-query.service';
import { CommentService } from '../application/comment.service';
import type { Viewer } from '../application/discussion-support';
import { PostService } from '../application/post.service';
import { VoteService } from '../application/vote.service';
import { validationFailed } from '../domain/discussion-errors';
import {
  BoardListQueryDto,
  CreateCommentDto,
  CreatePostDto,
  RepliesQueryDto,
  ThreadQueryDto,
  VoteDto,
} from './discussions.dto';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 25;

const viewerOf = (user: UserRawDto | null): Viewer => ({
  userId: user?.id ?? null,
  moderator: user?.role === Role.ADMIN || user?.role === Role.MODERATOR,
});

/** `limit` is an integer from 1 to 50; anything else is refused, never clamped (FR-031). */
function limitOf(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw validationFailed(['limit']);
  return limit;
}

@ApiTags('discussions')
@Controller()
export class DiscussionsController {
  constructor(
    private readonly boards: BoardQueryService,
    private readonly posts: PostService,
    private readonly comments: CommentService,
    private readonly votes: VoteService,
  ) {}

  // ---- boards and posts ------------------------------------------------------------------------------------------

  @Firewall()
  @Idempotent()
  @RateLimit('discussion.write')
  @Post('boards/:productId/posts')
  createPost(
    @Param('productId', ParseUUIDPipe) productId: string,
    @User() user: UserRawDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: CreatePostDto,
  ): Promise<PostView> {
    return this.posts.create({
      userId: user.id,
      boardId: productId,
      title: body.title,
      body: body.body,
      idempotencyKey,
    });
  }

  @Firewall({ anonymous: true })
  @Get('boards/:productId/posts')
  board(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Query() query: BoardListQueryDto,
    @User() user: UserRawDto | null,
  ): Promise<PostPage> {
    const sort: BoardSort = query.sort ?? 'hot';
    if (query.window !== undefined && sort !== 'top')
      throw validationFailed(['window']);
    const window: TopWindow = query.window ?? 'all';
    return this.boards.list(
      {
        boardId: productId.toLowerCase(),
        sort,
        window,
        limit: limitOf(query.limit),
        cursor: query.cursor ?? null,
      },
      viewerOf(user),
    );
  }

  @Firewall({ anonymous: true })
  @Get('posts/:postId')
  post(
    @Param('postId', ParseUUIDPipe) postId: string,
    @User() user: UserRawDto | null,
  ): Promise<PostView> {
    return this.posts.get(postId.toLowerCase(), viewerOf(user));
  }

  @Firewall()
  @HttpCode(204)
  @Delete('posts/:postId')
  async deletePost(
    @Param('postId', ParseUUIDPipe) postId: string,
    @User() user: UserRawDto,
  ): Promise<void> {
    await this.posts.delete(postId.toLowerCase(), viewerOf(user));
  }

  // ---- comments --------------------------------------------------------------------------------------------------

  @Firewall()
  @Idempotent()
  @RateLimit('discussion.write')
  @Post('posts/:postId/comments')
  comment(
    @Param('postId', ParseUUIDPipe) postId: string,
    @User() user: UserRawDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: CreateCommentDto,
  ): Promise<CommentView> {
    return this.comments.create({
      userId: user.id,
      postId: postId.toLowerCase(),
      body: body.body,
      parentId: body.parentId?.toLowerCase(),
      idempotencyKey,
    });
  }

  @Firewall({ anonymous: true })
  @Get('posts/:postId/comments')
  thread(
    @Param('postId', ParseUUIDPipe) postId: string,
    @Query() query: ThreadQueryDto,
    @User() user: UserRawDto | null,
  ): Promise<CommentThreadPage> {
    const sort: ThreadSort = query.sort ?? 'best';
    return this.comments.thread(
      {
        postId: postId.toLowerCase(),
        sort,
        limit: limitOf(query.limit),
        cursor: query.cursor ?? null,
      },
      viewerOf(user),
    );
  }

  @Firewall({ anonymous: true })
  @Get('comments/:commentId/replies')
  replies(
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Query() query: RepliesQueryDto,
    @User() user: UserRawDto | null,
  ): Promise<CommentRepliesPage> {
    return this.comments.replies(
      commentId.toLowerCase(),
      limitOf(query.limit),
      query.cursor ?? null,
      viewerOf(user),
    );
  }

  @Firewall()
  @HttpCode(204)
  @Delete('comments/:commentId')
  async deleteComment(
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @User() user: UserRawDto,
  ): Promise<void> {
    await this.comments.delete(commentId.toLowerCase(), viewerOf(user));
  }

  // ---- votes -----------------------------------------------------------------------------------------------------

  @Firewall()
  @RateLimit('discussion.vote')
  @Put('votes/:targetId')
  vote(
    @Param('targetId', ParseUUIDPipe) targetId: string,
    @User() user: UserRawDto,
    @Body() body: VoteDto,
  ): Promise<VoteResult> {
    return this.votes.vote(user.id, targetId.toLowerCase(), body.value);
  }
}
