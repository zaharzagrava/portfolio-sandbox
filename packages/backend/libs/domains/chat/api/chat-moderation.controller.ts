import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  moderationRequestSchema,
  muteRequestSchema,
  type ChatWsTicket,
} from '@marketplace-sandbox/contracts';
import { Firewall, User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { ChatModerationService } from '../application/chat-moderation.service';
import { ChatTicketService } from '../application/chat-ticket.service';
import { ChatZodPipe } from './chat-zod.pipe';

const user = new ChatZodPipe(moderationRequestSchema);
const mute = new ChatZodPipe(muteRequestSchema);

/** Moderation, message deletion and the gateway ticket (S24 contracts/http.md). All moderation answers `204`. */
@ApiTags('chat')
@Controller('chat')
export class ChatModerationController {
  constructor(
    private readonly moderation: ChatModerationService,
    private readonly tickets: ChatTicketService,
  ) {}

  /**
   * Management lives in NestJS; the realtime send/receive path is the Rust chat-gateway. This hands the client a
   * short-lived ticket to authenticate against it.
   */
  // sensitive: the credential opens a long-lived socket, so a revoked session is refused at once, not after its token expires
  @Firewall({ sensitive: true })
  @RateLimit('chat.ws-ticket.user')
  @HttpCode(HttpStatus.CREATED)
  @Post('ws-ticket')
  ticket(@User() who: AuthenticatedUser): ChatWsTicket {
    return this.tickets.mint(who.id);
  }

  @Firewall()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('channels/:channelId/members/ban')
  ban(
    @User() who: AuthenticatedUser,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body(user) body: { userId: string },
  ) {
    return this.moderation.moderate(who.id, channelId, 'ban', body.userId);
  }

  @Firewall()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('channels/:channelId/members/unban')
  unban(
    @User() who: AuthenticatedUser,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body(user) body: { userId: string },
  ) {
    return this.moderation.moderate(who.id, channelId, 'unban', body.userId);
  }

  @Firewall()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('channels/:channelId/members/promote')
  promote(
    @User() who: AuthenticatedUser,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body(user) body: { userId: string },
  ) {
    return this.moderation.moderate(who.id, channelId, 'promote', body.userId);
  }

  @Firewall()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('channels/:channelId/members/demote')
  demote(
    @User() who: AuthenticatedUser,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body(user) body: { userId: string },
  ) {
    return this.moderation.moderate(who.id, channelId, 'demote', body.userId);
  }

  @Firewall()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('channels/:channelId/members/mute')
  mute(
    @User() who: AuthenticatedUser,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body(mute) body: { userId: string; minutes: number },
  ) {
    return this.moderation.moderate(
      who.id,
      channelId,
      'mute',
      body.userId,
      body.minutes,
    );
  }

  @Firewall()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('channels/:channelId/members/unmute')
  unmute(
    @User() who: AuthenticatedUser,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body(user) body: { userId: string },
  ) {
    return this.moderation.moderate(who.id, channelId, 'unmute', body.userId);
  }

  @Firewall()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('channels/:channelId/messages/:messageId')
  deleteMessage(
    @User() who: AuthenticatedUser,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ) {
    return this.moderation.deleteMessage(who.id, channelId, messageId);
  }
}
