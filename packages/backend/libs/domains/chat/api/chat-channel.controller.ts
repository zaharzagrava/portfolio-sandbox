import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import {
  chatInboxQuerySchema,
  createChannelRequestSchema,
  updateChannelRequestSchema,
  type ChatChannel,
  type ChatInboxPage,
  type CreateChannelRequest,
  type UpdateChannelRequest,
} from '@marketplace-sandbox/contracts';
import { Firewall, User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { ChatChannelService } from '../application/chat-channel.service';
import { ChatZodPipe } from './chat-zod.pipe';

/**
 * Channels (S24 contracts/http.md). Thin: validated input, one application call; errors are `AppError`s the platform
 * filter renders as problem+json. Literal segments (`by-product`) are declared before the parametrised ones.
 */
@ApiTags('chat')
@Controller('chat')
export class ChatChannelController {
  constructor(private readonly channels: ChatChannelService) {}

  @Firewall()
  @RateLimit('chat.channel-create.user')
  @HttpCode(HttpStatus.CREATED)
  @Post('channels')
  create(
    @User() user: AuthenticatedUser,
    @Body(new ChatZodPipe(createChannelRequestSchema))
    body: CreateChannelRequest,
  ): Promise<ChatChannel> {
    return this.channels.create(user.id, body);
  }

  @Firewall()
  @RateLimit('chat.read.user')
  @Get('channels/mine')
  mine(
    @User() user: AuthenticatedUser,
    @Query(new ChatZodPipe(chatInboxQuerySchema))
    query: z.output<typeof chatInboxQuerySchema>,
  ): Promise<ChatInboxPage> {
    return this.channels.mine(user.id, query);
  }

  @Firewall()
  @Get('channels/by-product/:productId')
  byProduct(
    @User() user: AuthenticatedUser,
    @Param('productId', ParseUUIDPipe) productId: string,
  ): Promise<ChatChannel> {
    return this.channels.byProduct(productId, user.id);
  }

  @Firewall()
  @RateLimit('chat.join.user')
  @HttpCode(HttpStatus.OK)
  @Post('channels/:channelId/join')
  join(
    @User() user: AuthenticatedUser,
    @Param('channelId', ParseUUIDPipe) channelId: string,
  ): Promise<ChatChannel> {
    return this.channels.join(channelId, user.id);
  }

  @Firewall()
  @Get('channels/:channelId')
  get(
    @User() user: AuthenticatedUser,
    @Param('channelId', ParseUUIDPipe) channelId: string,
  ): Promise<ChatChannel> {
    return this.channels.get(channelId, user.id);
  }

  @Firewall()
  @Patch('channels/:channelId')
  update(
    @User() user: AuthenticatedUser,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body(new ChatZodPipe(updateChannelRequestSchema))
    body: UpdateChannelRequest,
  ): Promise<ChatChannel> {
    return this.channels.update(channelId, user.id, body);
  }
}
