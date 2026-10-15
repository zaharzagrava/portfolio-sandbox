import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { WebhookReplayService } from './application/webhook-replay.service';
import { WebhookEventTypesController } from './api/webhook-event-types.controller';
import { WebhooksController } from './api/webhooks.controller';
import { WebhookEndpointsService } from './application/webhook-endpoints.service';
import { DeveloperPlatformCoreModule } from './developer-platform-core.module';
import { developerPlatformRatePolicies } from './rate-limit-policies';
import { WebhooksCoreModule } from './webhooks-core.module';

/**
 * The dashboard side (apps/core): endpoint management, log, replay, ping. `DeveloperPlatformCoreModule` provides
 * `ApiVersionService` and `VersionPinCache` (S42 R1) for the pinned version of a new endpoint; `AuthModule` provides
 * `SecretBox`; the rate-limit module registers `webhooks.manage.shop`, `webhooks.replay.shop` and
 * `webhooks.ping.endpoint` (S50, all fail closed). Each is imported explicitly so the module boots alone (L-018).
 */
@Module({
  imports: [
    AuthModule,
    DeveloperPlatformCoreModule,
    IdempotencyModule,
    WebhooksCoreModule,
    RateLimitModule.forFeature(developerPlatformRatePolicies),
  ],
  controllers: [WebhooksController, WebhookEventTypesController],
  providers: [WebhookEndpointsService, WebhookReplayService],
})
export class WebhooksModule {}
