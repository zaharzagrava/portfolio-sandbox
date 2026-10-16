import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type {
  FeedPage,
  FollowStatus,
  FollowingPage,
} from '@marketplace-sandbox/contracts';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { FeedReadService } from '../application/feed-read.service';
import {
  FOLLOWING_DEFAULT_LIMIT,
  FOLLOWING_MAX_LIMIT,
  FollowService,
} from '../application/follow.service';
import {
  AccountParamDto,
  FollowStatusQueryDto,
  PageQueryDto,
  pageLimit,
  splitAccountIds,
} from './feed.dto';

const FEED_DEFAULT_LIMIT = 30;
const FEED_MAX_LIMIT = 50;

/** Follow graph and home feed (S26): thin; validation, rules and storage live in the application and infra layers. */
@ApiTags('feed')
@Controller()
export class FeedController {
  constructor(
    private readonly follows: FollowService,
    private readonly reads: FeedReadService,
  ) {}

  @Firewall()
  @RateLimit('feed.read')
  @Get('feed')
  feed(
    @User() user: UserRawDto,
    @Query() query: PageQueryDto,
  ): Promise<FeedPage> {
    return this.reads.page(
      user.id,
      pageLimit(query.limit, FEED_DEFAULT_LIMIT, FEED_MAX_LIMIT),
      query.cursor,
    );
  }

  @Firewall()
  @RateLimit('follow.write')
  @HttpCode(204)
  @Post('follow/:accountId')
  async follow(
    @User() user: UserRawDto,
    @Param() params: AccountParamDto,
  ): Promise<void> {
    await this.follows.follow(user.id, params.accountId);
  }

  @Firewall()
  @RateLimit('follow.write')
  @HttpCode(204)
  @Delete('follow/:accountId')
  async unfollow(
    @User() user: UserRawDto,
    @Param() params: AccountParamDto,
  ): Promise<void> {
    await this.follows.unfollow(user.id, params.accountId);
  }

  @Firewall()
  @Get('me/following')
  following(
    @User() user: UserRawDto,
    @Query() query: PageQueryDto,
  ): Promise<FollowingPage> {
    return this.follows.following(
      user.id,
      pageLimit(query.limit, FOLLOWING_DEFAULT_LIMIT, FOLLOWING_MAX_LIMIT),
      query.cursor,
    );
  }

  @Firewall()
  @RateLimit('feed.read')
  @Get('follow-status')
  followStatus(
    @User() user: UserRawDto,
    @Query() query: FollowStatusQueryDto,
  ): Promise<FollowStatus> {
    return this.follows.status(user.id, splitAccountIds(query.accountIds));
  }
}
