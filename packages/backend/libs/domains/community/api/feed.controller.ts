import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { FeedService } from '../application/feed.service';

const ACCOUNT_ID =
  /^(shop|user):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

@ApiTags('feed')
@Controller()
export class FeedController {
  constructor(private readonly feed: FeedService) {}

  @Firewall()
  @Get('feed')
  timeline(@User() user: UserRawDto, @Query('before') before?: string) {
    return this.feed.timeline(user.id, 30, before ? Number(before) : undefined);
  }

  @Firewall()
  @HttpCode(204)
  @Post('follow/:accountId')
  follow(@User() user: UserRawDto, @Param('accountId') accountId: string) {
    if (!ACCOUNT_ID.test(accountId))
      throw new BadRequestException(
        'accountId must be shop:<uuid> or user:<uuid>',
      );
    if (accountId === `user:${user.id}`)
      throw new BadRequestException("You can't follow yourself");
    return this.feed.follow(user.id, accountId);
  }

  @Firewall()
  @HttpCode(204)
  @Delete('follow/:accountId')
  unfollow(@User() user: UserRawDto, @Param('accountId') accountId: string) {
    if (!ACCOUNT_ID.test(accountId))
      throw new BadRequestException(
        'accountId must be shop:<uuid> or user:<uuid>',
      );
    return this.feed.unfollow(user.id, accountId);
  }

  @Firewall()
  @Get('me/following')
  following(@User() user: UserRawDto) {
    return this.feed.following(user.id);
  }
}
