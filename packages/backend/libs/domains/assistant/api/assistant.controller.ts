import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  assistantConversationIdSchema,
  assistantConversationListQuerySchema,
  assistantCreateConversationRequestSchema,
  assistantIdempotencyKeySchema,
  assistantLastEventIdSchema,
  assistantSendMessageRequestSchema,
  type AssistantConversationListQuery,
  type AssistantCreateConversationRequest,
  type AssistantSendMessageRequest,
} from '@marketplace-sandbox/contracts';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import {
  GENERATION_STORE,
  type GenerationStore,
} from '../domain/assistant-ports';
import { isTimeUuid } from '../domain/conversation-cursor';
import { AllowanceService } from '../application/allowance.service';
import {
  Domain_GenerationNotFound,
  Domain_IdempotencyKeyRequired,
  Domain_InvalidLastEventId,
} from '../application/assistant-errors';
import { AssistantTurnService } from '../application/assistant-turn.service';
import { ConversationService } from '../application/conversation.service';
import { GenerationService } from '../application/generation.service';
import { AssistantStreamer } from './assistant-stream';
import { ZodPipe } from './zod.pipe';

const idPipe = new ZodPipe(assistantConversationIdSchema, 'id');

/**
 * The shopping assistant API (contracts/http-api.md). Every route needs a signed-in user and every lookup carries the
 * caller's id, so another user's conversation or reply is a plain `404`. Bodies, headers and parameters are validated
 * with the shared contract schemas before anything is touched.
 */
@ApiTags('assistant')
@Controller('assistant')
export class AssistantController {
  constructor(
    private readonly conversations: ConversationService,
    private readonly turns: AssistantTurnService,
    private readonly generations: GenerationService,
    private readonly allowance: AllowanceService,
    private readonly streamer: AssistantStreamer,
    @Inject(GENERATION_STORE) private readonly store: GenerationStore,
  ) {}

  @Firewall()
  @Post('conversations')
  create(
    @User() user: UserRawDto,
    @Body(new ZodPipe(assistantCreateConversationRequestSchema))
    body: AssistantCreateConversationRequest,
  ) {
    return this.conversations.create(user.id, body.title);
  }

  @Firewall()
  @Get('conversations')
  list(
    @User() user: UserRawDto,
    @Query(new ZodPipe(assistantConversationListQuerySchema))
    query: AssistantConversationListQuery,
  ) {
    return this.conversations.list(user.id, query);
  }

  @Firewall()
  @Get('conversations/:id/messages')
  history(@User() user: UserRawDto, @Param('id', idPipe) id: string) {
    return this.conversations.history(user.id, id);
  }

  @Firewall()
  @HttpCode(204)
  @Delete('conversations/:id')
  async remove(@User() user: UserRawDto, @Param('id', idPipe) id: string) {
    await this.conversations.remove(user.id, id);
  }

  @Firewall()
  @Get('usage')
  async usage(@User() user: UserRawDto) {
    const { used, limit, resetsAt } = await this.allowance.current(user.id);
    return { used, limit, resetsAt: resetsAt.toISOString() };
  }

  /**
   * Send a message; the response IS the reply, as text/event-stream (`meta`, `text`/`tool`…, one of `done`/`refusal`/
   * `error`). Errors before the stream starts are normal problem responses. A repeated `Idempotency-Key` with the same
   * body replays the stored reply.
   */
  @Firewall()
  @Post('conversations/:id/messages')
  async send(
    @User() user: UserRawDto,
    @Param('id', idPipe) id: string,
    @Body(new ZodPipe(assistantSendMessageRequestSchema))
    body: AssistantSendMessageRequest,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Res() res: Response,
  ) {
    if (rawKey === undefined || rawKey.trim() === '')
      throw new Domain_IdempotencyKeyRequired();
    const idempotencyKey = new ZodPipe(
      assistantIdempotencyKeySchema,
      'Idempotency-Key',
    ).transform(rawKey);
    const result = await this.turns.send(user.id, id, {
      idempotencyKey,
      text: body.text,
      lat: body.lat,
      lng: body.lng,
    });
    await this.streamer.pipe(user.id, result.messageId, undefined, res, {
      ...result.headers,
      ...(result.kind === 'replay' && { 'Idempotent-Replay': 'true' }),
    });
  }

  @Firewall()
  @Get('messages/:messageId/stream')
  async resume(
    @User() user: UserRawDto,
    @Param('messageId') messageId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Res() res: Response,
  ) {
    if (
      lastEventId !== undefined &&
      !assistantLastEventIdSchema.safeParse(lastEventId).success
    )
      throw new Domain_InvalidLastEventId();
    await this.assertGeneration(user.id, messageId);
    await this.streamer.pipe(user.id, messageId, lastEventId, res);
  }

  /** The stop button: aborts the provider call wherever the generation runs. */
  @Firewall()
  @HttpCode(202)
  @Post('messages/:messageId/cancel')
  async cancel(
    @User() user: UserRawDto,
    @Param('messageId') messageId: string,
  ) {
    await this.assertGeneration(user.id, messageId);
    await this.generations.cancel(user.id, messageId);
    return { cancelling: true as const };
  }

  /** Unknown, expired and foreign generations are the same `404`: the user id is part of the lookup key. */
  private async assertGeneration(userId: string, messageId: string) {
    if (!isTimeUuid(messageId) || !(await this.store.meta(userId, messageId)))
      throw new Domain_GenerationNotFound();
  }
}
