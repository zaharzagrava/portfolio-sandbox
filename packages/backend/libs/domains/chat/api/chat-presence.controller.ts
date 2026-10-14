import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import {
  presenceQuerySchema,
  type PresenceResponse,
} from '@marketplace-sandbox/contracts';
import { Firewall, User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { ChatPresenceService } from '../application/chat-presence.service';
import { ChatZodPipe } from './chat-zod.pipe';

/** Presence (S24 contracts/http.md). */
@ApiTags('chat')
@Controller('chat')
export class ChatPresenceController {
  constructor(private readonly presence: ChatPresenceService) {}

  @Firewall()
  @RateLimit('chat.heartbeat.user')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('presence/heartbeat')
  async heartbeat(@User() user: AuthenticatedUser): Promise<void> {
    await this.presence.heartbeat(user.id);
  }

  @Firewall()
  @RateLimit('chat.presence.user')
  @Get('presence')
  query(
    @User() user: AuthenticatedUser,
    @Query(new ChatZodPipe(presenceQuerySchema))
    query: z.output<typeof presenceQuerySchema>,
  ): Promise<PresenceResponse> {
    return this.presence.query(user.id, query.userIds);
  }
}
