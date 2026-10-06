import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, NotFoundException, Param, Post, Req, Res } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsLatitude, IsLongitude, IsOptional, IsString, Length, Matches } from 'class-validator';
import type { Request, Response } from 'express';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit/rate-limit.decorator';
import { AssistantService } from '../application/assistant.service';
import { AssistantStreamer } from './assistant-stream';
import { AssistantQuotaService } from '../application/assistant-quota.service';
import { GenerationBuffer } from '../infra/generation-buffer';
import { AssistantRetryLaterError } from '../application/assistant-errors';

const TIME_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STREAM_ID = /^\d+-\d+$/;

export class CreateConversationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 120) title?: string;
}

export class SendAssistantMessageDto {
  @ApiProperty() @IsString() @Length(1, 4000) text: string;
  /** Device location, only when the shopper shared it (pickup_near_me tool). */
  @ApiPropertyOptional() @IsOptional() @IsLatitude() lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsLongitude() lng?: number;
}

class ConversationParam {
  @Matches(TIME_UUID) id: string;
}

@ApiTags('assistant')
@Controller('assistant')
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly streamer: AssistantStreamer,
    private readonly buffer: GenerationBuffer,
    private readonly quota: AssistantQuotaService,
  ) {}

  @Firewall()
  @Post('conversations')
  create(@User() user: UserRawDto, @Body() body: CreateConversationDto) {
    return this.assistant.createConversation(user.id, body.title);
  }

  @Firewall()
  @Get('conversations')
  list(@User() user: UserRawDto) {
    return this.assistant.listConversations(user.id);
  }

  @Firewall()
  @Get('conversations/:id/messages')
  history(@User() user: UserRawDto, @Param() params: ConversationParam) {
    return this.assistant.history(user.id, params.id);
  }

  @Firewall()
  @Get('usage')
  usage(@User() user: UserRawDto) {
    return this.quota.usage(user.id);
  }

  /**
   * Send a message; the response IS the reply, as text/event-stream:
   * `meta` {messageId} → `text` {t}… / `tool` {name,status}… → `done` | `refusal` | `error`.
   * Errors before the stream starts (404, 409 turn in progress, 429 quota) are normal JSON responses.
   * Lost the connection? GET /assistant/messages/:messageId/stream with Last-Event-ID.
   */
  @Firewall({ skipThrottle: true })
  @RateLimit('llm.messages')
  @Post('conversations/:id/messages')
  async send(@User() user: UserRawDto, @Param() params: ConversationParam, @Body() body: SendAssistantMessageDto, @Req() req: Request, @Res() res: Response) {
    const location = body.lat !== undefined && body.lng !== undefined ? { lat: Number(body.lat), lng: Number(body.lng) } : null;
    const { messageId } = await this.assistant.startTurn(user.id, params.id, { text: body.text, location }).catch((error) => {
      if (error instanceof AssistantRetryLaterError) res.setHeader('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
      throw error;
    });
    await this.streamer.pipe(messageId, null, req, res);
  }

  @Firewall({ skipThrottle: true })
  @Get('messages/:messageId/stream')
  async resume(@User() user: UserRawDto, @Param('messageId') messageId: string, @Headers('last-event-id') lastEventId: string | undefined, @Req() req: Request, @Res() res: Response) {
    await this.assertOwner(user.id, messageId);
    await this.streamer.pipe(messageId, lastEventId && STREAM_ID.test(lastEventId) ? lastEventId : null, req, res);
  }

  /** Stop button: aborts the provider call wherever the generation runs. */
  @Firewall()
  @HttpCode(202)
  @Post('messages/:messageId/cancel')
  async cancel(@User() user: UserRawDto, @Param('messageId') messageId: string) {
    await this.assertOwner(user.id, messageId);
    await this.assistant.cancel(user.id, messageId);
    return { cancelling: true };
  }

  private async assertOwner(userId: string, messageId: string) {
    if (!TIME_UUID.test(messageId)) throw new NotFoundException();
    const owner = await this.buffer.owner(messageId);
    if (!owner) throw new NotFoundException('Generation not found or expired');
    if (owner.userId !== userId) throw new ForbiddenException();
  }
}
