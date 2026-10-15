import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  createWebhookEndpointRequestSchema,
  rotateWebhookSecretRequestSchema,
  updateWebhookEndpointRequestSchema,
  webhookAttemptsQuerySchema,
  webhookEndpointListQuerySchema,
  WEBHOOK_LIMITS,
} from '@marketplace-sandbox/contracts';
import { User, type AuthenticatedUser } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import {
  Idempotent,
  type IdempotentWireOptions,
} from '@app/infrastructure/idempotency';
import { RateLimit } from '@app/infrastructure/rate-limit';
import type {
  CreateWebhookEndpointRequest,
  RotateWebhookSecretRequest,
  UpdateWebhookEndpointRequest,
} from '../application/dto/webhook-endpoint.dto';
import { WebhookEndpointsService } from '../application/webhook-endpoints.service';
import { WebhookReplayService } from '../application/webhook-replay.service';
import { ZodBodyPipe } from './zod-body.pipe';

/** A rotate call may carry no body at all: that is the same as `{}` (24 h overlap). */
const rotateBody = new ZodBodyPipe(
  z.preprocess((v) => v ?? {}, rotateWebhookSecretRequestSchema),
);

/** Replay answers `Idempotent-Replayed: true` on a repeat (contracts/http.md); a malformed key is an ordinary `400`. */
const REPLAY_IDEMPOTENCY: IdempotentWireOptions = {
  replayHeader: 'Idempotent-Replayed',
  invalidKey: { status: 400, code: 'validation_failed' },
};

/**
 * Dashboard routes of the webhook endpoints (FR-001 to FR-015, FR-045 to FR-047, contracts/http.md): `webhooks.manage` on
 * every route (OWNER and ADMIN), mutations limited per shop (`webhooks.manage.shop`, fail closed; replay and ping have
 * their own policies). Calls the application services only; every lookup there carries the shop, so another shop's id is
 * an unknown id. The CSRF check of cookie sessions is the platform's guard (S01); bearer calls need none.
 */
@ApiTags('developers')
@Controller('shops/:shopId/developers/webhooks')
export class WebhooksController {
  constructor(
    private readonly endpoints: WebhookEndpointsService,
    private readonly replays: WebhookReplayService,
  ) {}

  @ShopScoped('webhooks.manage')
  @RateLimit('webhooks.manage.shop')
  @Post()
  create(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(createWebhookEndpointRequestSchema))
    body: CreateWebhookEndpointRequest,
  ) {
    return this.endpoints.create(shopId, user.id, body);
  }

  @ShopScoped('webhooks.manage')
  @Get()
  list(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Query(new ZodBodyPipe(webhookEndpointListQuerySchema))
    query: { limit: number; cursor?: string },
  ) {
    return this.endpoints.list(shopId, query);
  }

  @ShopScoped('webhooks.manage')
  @Get(':id')
  get(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.endpoints.get(shopId, id);
  }

  @ShopScoped('webhooks.manage')
  @RateLimit('webhooks.manage.shop')
  @Patch(':id')
  update(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @User() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(updateWebhookEndpointRequestSchema))
    body: UpdateWebhookEndpointRequest,
  ) {
    return this.endpoints.update(shopId, id, user.id, body);
  }

  @ShopScoped('webhooks.manage')
  @RateLimit('webhooks.manage.shop')
  @Post(':id/enable')
  @HttpCode(200)
  enable(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @User() user: AuthenticatedUser,
  ) {
    return this.endpoints.enable(shopId, id, user.id);
  }

  @ShopScoped('webhooks.manage')
  @RateLimit('webhooks.manage.shop')
  @Post(':id/disable')
  @HttpCode(200)
  disable(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @User() user: AuthenticatedUser,
  ) {
    return this.endpoints.disable(shopId, id, user.id);
  }

  @ShopScoped('webhooks.manage')
  @RateLimit('webhooks.manage.shop')
  @Post(':id/rotate-secret')
  rotate(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @User() user: AuthenticatedUser,
    @Body(rotateBody) body: RotateWebhookSecretRequest,
  ) {
    return this.endpoints.rotateSecret(
      shopId,
      id,
      user.id,
      body.overlapHours ?? WEBHOOK_LIMITS.overlapHours.default,
    );
  }

  @ShopScoped('webhooks.manage')
  @RateLimit('webhooks.manage.shop')
  @Post(':id/expire-previous-secret')
  @HttpCode(200)
  expirePreviousSecret(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @User() user: AuthenticatedUser,
  ) {
    return this.endpoints.expirePreviousSecret(shopId, id, user.id);
  }

  // ------------------------------------------------------------ log, replay, test event

  @ShopScoped('webhooks.manage')
  @Get(':id/attempts')
  attempts(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodBodyPipe(webhookAttemptsQuerySchema))
    query: {
      eventId?: string;
      ok?: 'true' | 'false';
      limit: number;
      cursor?: string;
    },
  ) {
    return this.replays.listAttempts(shopId, id, query);
  }

  @ShopScoped('webhooks.manage')
  @Get(':id/events/:eventId')
  event(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('eventId') eventId: string,
  ) {
    return this.replays.eventDetail(shopId, id, eventId);
  }

  @ShopScoped('webhooks.manage')
  @RateLimit('webhooks.replay.shop')
  @Idempotent({
    required: true,
    ttlSeconds: WEBHOOK_LIMITS.idempotencyTtlHours * 3600,
    scope: (req) => `shop:${req.params.shopId}:webhooks.replay`,
    wire: REPLAY_IDEMPOTENCY,
  })
  @Post(':id/events/:eventId/replay')
  @HttpCode(202)
  replay(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('eventId') eventId: string,
  ) {
    return this.replays.replay(shopId, id, eventId);
  }

  @ShopScoped('webhooks.manage')
  @RateLimit({
    policy: 'webhooks.ping.endpoint',
    subject: (req) => String(req.params.id),
  })
  @Post(':id/ping')
  @HttpCode(202)
  ping(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.replays.ping(shopId, id);
  }

  @ShopScoped('webhooks.manage')
  @RateLimit('webhooks.manage.shop')
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @User() user: AuthenticatedUser,
  ): Promise<void> {
    await this.endpoints.remove(shopId, id, user.id);
  }
}
