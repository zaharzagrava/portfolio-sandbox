import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import {
  chatMarkReadRequestSchema,
  unreadQuerySchema,
  type ChatReceipts,
  type ChatUnreadPage,
} from '@marketplace-sandbox/contracts';
import { Firewall, User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { ChatReadStateService } from '../application/chat-read-state.service';
import { ChatZodPipe } from './chat-zod.pipe';

/** Unread counts and read receipts (S24 contracts/http.md). */
@ApiTags('chat')
@Controller('chat')
export class ChatReadStateController {
  constructor(private readonly readState: ChatReadStateService) {}

  @Firewall()
  @RateLimit('chat.read.user')
  @Get('unread')
  unread(
    @User() user: AuthenticatedUser,
    @Query(new ChatZodPipe(unreadQuerySchema))
    query: z.output<typeof unreadQuerySchema>,
  ): Promise<ChatUnreadPage> {
    return this.readState.unread(user.id, query);
  }

  @Firewall()
  @RateLimit('chat.read.user')
  @Get('channels/:channelId/receipts')
  receipts(
    @User() user: AuthenticatedUser,
    @Param('channelId', ParseUUIDPipe) channelId: string,
  ): Promise<ChatReceipts> {
    return this.readState.receipts(user.id, channelId);
  }

  @Firewall()
  @RateLimit('chat.read.user')
  @HttpCode(HttpStatus.OK)
  @Post('channels/:channelId/read')
  read(
    @User() user: AuthenticatedUser,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body(new ChatZodPipe(chatMarkReadRequestSchema)) body: { seq: number },
  ): Promise<{ lastReadSeq: number; unread: number }> {
    return this.readState.markRead(user.id, channelId, body.seq);
  }
}
