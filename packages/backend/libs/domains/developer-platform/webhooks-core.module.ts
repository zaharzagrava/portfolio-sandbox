import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { DynamoModule } from '@app/infrastructure/dynamo/dynamo.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { DEVELOPER_PLATFORM_AGGREGATE } from './application/events/webhook-events';
import { WebhookEndpointsService } from './application/webhook-endpoints.service';
import { WebhookRouterProjector } from './infra/webhook-router.projector';
import { WebhookDeliverer } from './application/webhook-deliverer.service';

/** Shared SD-30 services (core dashboard, projector router, worker/Lambda delivery). AuthModule provides SecretBox. */
@Module({
  imports: [
    AuthModule,
    CacheModule,
    SqsModule,
    DynamoModule,
    JobsModule,
    EventsModule.forAggregates([DEVELOPER_PLATFORM_AGGREGATE]),
  ],
  providers: [
    WebhookEndpointsService,
    WebhookRouterProjector,
    WebhookDeliverer,
  ],
  exports: [WebhookEndpointsService, WebhookRouterProjector, WebhookDeliverer],
})
export class WebhooksCoreModule {}
