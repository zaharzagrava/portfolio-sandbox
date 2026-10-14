import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  type PipeTransform,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  chatSyncRequestSchema,
  type ChatChannelSync,
  type ChatSyncRequest,
} from '@marketplace-sandbox/contracts';
import { Firewall, User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { ChatSyncService } from '../application/chat-sync.service';
import { ChatValidationError, tooManyChannels } from '../domain/errors';

/** More than 50 channels is `400 too_many_channels`; anything else wrong with the body is `400 validation_failed`. */
class SyncRequestPipe implements PipeTransform<unknown, ChatSyncRequest> {
  transform(value: unknown): ChatSyncRequest {
    const parsed = chatSyncRequestSchema.safeParse(value ?? {});
    if (parsed.success) return parsed.data;
    if (parsed.error.issues.some((i) => i.message === 'too_many_channels'))
      throw tooManyChannels();
    throw new ChatValidationError(['cursors']);
  }
}

/** `POST /chat/sync` (S24 contracts/http.md): a read, a POST because the cursor map can be large. */
@ApiTags('chat')
@Controller('chat')
export class ChatSyncController {
  constructor(private readonly sync: ChatSyncService) {}

  @Firewall()
  @RateLimit('chat.sync.user')
  @HttpCode(HttpStatus.OK)
  @Post('sync')
  run(
    @User() user: AuthenticatedUser,
    @Body(new SyncRequestPipe()) body: ChatSyncRequest,
  ): Promise<ChatChannelSync[]> {
    return this.sync.sync(user.id, body.cursors);
  }
}
