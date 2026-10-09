import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit/rate-limit.decorator';
import { DiscussionService } from '../application/discussion.service';
import type { BoardSort } from '../application/discussion.service';
import { VoteService } from '../application/vote.service';
import { CreateCommentDto, CreatePostDto, VoteDto } from './discussions.dto';

@ApiTags('discussions')
@Controller()
export class DiscussionsController {
  constructor(
    private readonly discussions: DiscussionService,
    private readonly votes: VoteService,
  ) {}

  /** Board per product (`productId`) or brand (`brand:apple`). */
  @Firewall()
  @RateLimit('discussion.write')
  @Post('boards/:boardId/posts')
  createPost(
    @Param('boardId') boardId: string,
    @User() user: UserRawDto,
    @Body() body: CreatePostDto,
  ) {
    return this.discussions.createPost(
      boardId.slice(0, 64),
      user.id,
      body.title,
      body.body,
    );
  }

  @Firewall({ anonymous: true, skipThrottle: true })
  @Get('boards/:boardId/posts')
  board(
    @Param('boardId') boardId: string,
    @Query('sort') sort: BoardSort = 'hot',
    @Query('cursor') cursor?: string,
  ) {
    return this.discussions.listBoard(
      boardId.slice(0, 64),
      ['hot', 'new', 'top'].includes(sort) ? sort : 'hot',
      cursor,
    );
  }

  @Firewall({ anonymous: true, skipThrottle: true })
  @Get('posts/:postId')
  post(@Param('postId', ParseUUIDPipe) postId: string) {
    return this.discussions.getPost(postId);
  }

  @Firewall({ anonymous: true, skipThrottle: true })
  @Get('posts/:postId/comments')
  comments(
    @Param('postId', ParseUUIDPipe) postId: string,
    @Query('sort') sort: 'new' | 'best' = 'best',
  ) {
    return sort === 'new'
      ? this.discussions.thread(postId)
      : this.discussions.bestThread(postId);
  }

  @Firewall()
  @RateLimit('discussion.write')
  @Post('posts/:postId/comments')
  comment(
    @Param('postId', ParseUUIDPipe) postId: string,
    @User() user: UserRawDto,
    @Body() body: CreateCommentDto,
  ) {
    return this.discussions.addComment(
      postId,
      user.id,
      body.body,
      body.parentId,
    );
  }

  @Firewall()
  @HttpCode(204)
  @Delete('comments/:commentId')
  deleteComment(
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @User() user: UserRawDto,
  ) {
    return this.discussions.deleteComment(commentId, user.id);
  }

  @Firewall()
  @RateLimit('discussion.vote')
  @Put('votes/:targetId')
  vote(
    @Param('targetId', ParseUUIDPipe) targetId: string,
    @User() user: UserRawDto,
    @Body() body: VoteDto,
  ) {
    return this.votes.vote(user.id, body.targetType, targetId, body.value);
  }
}
