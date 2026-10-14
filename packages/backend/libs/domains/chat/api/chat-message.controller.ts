import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { z } from 'zod';
import {
  historyQuerySchema,
  sendMessageRequestSchema,
  type ChatMessagePage,
  type SendMessageRequest,
  type SendMessageResponse,
} from '@marketplace-sandbox/contracts';
import { Firewall, User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { ChatMessageService } from '../application/chat-message.service';
import { ChatZodPipe } from './chat-zod.pipe';

/** Messages (S24 contracts/http.md). `201` for a new message, `200` for an identical replay. */
@ApiTags('chat')
@Controller('chat')
export class ChatMessageController {
  constructor(private readonly messages: ChatMessageService) {}

  @Firewall()
  @RateLimit('chat.send.user')
  @Post('channels/:channelId/messages')
  async send(
    @User() user: AuthenticatedUser,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body(new ChatZodPipe(sendMessageRequestSchema)) body: SendMessageRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SendMessageResponse> {
    const result = await this.messages.send(user.id, channelId, body);
    res.status(result.duplicate ? HttpStatus.OK : HttpStatus.CREATED);
    return result;
  }

  /** Newest first, `{items, nextCursor}`; `limit` 1-100 (default 50), an opaque cursor. */
  @Firewall()
  @RateLimit('chat.read.user')
  @Get('channels/:channelId/messages')
  history(
    @User() user: AuthenticatedUser,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Query(new ChatZodPipe(historyQuerySchema))
    query: z.output<typeof historyQuerySchema>,
  ): Promise<ChatMessagePage> {
    return this.messages.history(user.id, channelId, query);
  }
}
