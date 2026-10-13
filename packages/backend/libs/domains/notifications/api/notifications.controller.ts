import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type {
  ListNotificationsQuery,
  MarkReadRequest,
  NotificationPage,
  UnreadCount,
} from '@marketplace-sandbox/contracts';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { InboxService } from '../application/inbox.service';
import { listNotificationsQuery, markReadBody } from './notifications.dto';

/**
 * The inbox routes (contracts/http.md). Preferences and settings live in `PreferencesController`, devices in
 * `DevicesController`, the unsubscribe link in `UnsubscribeController`.
 */
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly inbox: InboxService) {}

  @Firewall()
  @RateLimit('notifications.read.user')
  @Get()
  list(
    @User() user: UserRawDto,
    @Query(listNotificationsQuery) query: ListNotificationsQuery,
  ): Promise<NotificationPage> {
    return this.inbox.list(user.id, query);
  }

  @Firewall()
  @RateLimit('notifications.read.user')
  @Get('unread-count')
  async unread(@User() user: UserRawDto): Promise<UnreadCount> {
    return { unread: await this.inbox.unreadCount(user.id) };
  }

  @Firewall()
  @RateLimit('notifications.write.user')
  @Post('read')
  @HttpCode(200)
  async markRead(
    @User() user: UserRawDto,
    @Body(markReadBody) body: MarkReadRequest,
  ): Promise<UnreadCount> {
    return {
      unread:
        'all' in body
          ? await this.inbox.markAllRead(user.id)
          : await this.inbox.markRead(user.id, body.ids),
    };
  }
}
