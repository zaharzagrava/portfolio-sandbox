import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { DynamoModule } from '@app/infrastructure/dynamo/dynamo.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { InboxModule } from '@app/infrastructure/inbox';
import { DEVELOPER_PLATFORM_AGGREGATE } from './application/events/webhook-events';
import { WebhookDeliveryService } from './application/webhook-delivery.service';
import { WebhookLifecycleService } from './application/webhook-lifecycle.service';
import { WebhookRoutingService } from './application/webhook-routing.service';
import { WebhookSubscriptions } from './application/webhook-subscriptions.service';
import { SafeAddressGuard } from './infra/safe-address.guard';
import {
  AddressGuard,
  BreakerStore,
  DeliveryLog,
  DeliveryQueue,
  EndpointHistory,
  EndpointRepository,
  OutboundHttp,
  RandomSource,
  RoutingReceipts,
} from './domain/webhook-ports';
import { DynamoDeliveryLogStore } from './infra/dynamo-delivery-log.store';
import { InboxRoutingReceipts } from './infra/inbox-routing-receipts';
import { MathRandomSource } from './infra/math-random.source';
import { RedisBreakerStore } from './infra/redis-breaker.store';
import {
  SafeOutboundHttpAdapter,
  WEBHOOK_NET_OPTIONS,
} from './infra/safe-outbound-http.adapter';
import { SequelizeWebhookEndpointRepository } from './infra/sequelize-webhook-endpoint.repository';
import { SequelizeWebhookHistoryRepository } from './infra/sequelize-webhook-history.repository';
import { SqsDeliveryQueue } from './infra/sqs-delivery.queue';
import {
  WEBHOOK_SETTINGS,
  webhookSettingsProvider,
} from './infra/webhook-settings.provider';

/** The outbox of the capability's own events (re-exported: the dashboard service appends in its transactions). */
const WEBHOOK_EVENTS = EventsModule.forAggregates([
  DEVELOPER_PLATFORM_AGGREGATE,
]);

/**
 * What every deployable of the webhook capability shares (dashboard, projector, worker, Lambda host): the validated
 * settings, the ports with their adapters and the services built on them. Each deployable module imports this one
 * explicitly (L-018). `AuthModule` provides `SecretBox`. Nothing here is exported by the barrel.
 */
@Module({
  imports: [
    AuthModule,
    CacheModule,
    SqsModule,
    DynamoModule,
    JobsModule,
    InboxModule,
    WEBHOOK_EVENTS,
  ],
  providers: [
    webhookSettingsProvider,
    {
      provide: EndpointRepository,
      useClass: SequelizeWebhookEndpointRepository,
    },
    { provide: EndpointHistory, useClass: SequelizeWebhookHistoryRepository },
    { provide: DeliveryLog, useClass: DynamoDeliveryLogStore },
    { provide: BreakerStore, useClass: RedisBreakerStore },
    { provide: DeliveryQueue, useClass: SqsDeliveryQueue },
    { provide: OutboundHttp, useClass: SafeOutboundHttpAdapter },
    { provide: AddressGuard, useClass: SafeAddressGuard },
    { provide: RandomSource, useClass: MathRandomSource },
    { provide: RoutingReceipts, useClass: InboxRoutingReceipts },
    // Test seam of the outbound call (resolver, stand-in CA and address map); empty in production.
    { provide: WEBHOOK_NET_OPTIONS, useValue: {} },
    WebhookSubscriptions,
    WebhookRoutingService,
    WebhookDeliveryService,
    WebhookLifecycleService,
  ],
  exports: [
    WEBHOOK_EVENTS,
    WEBHOOK_SETTINGS,
    EndpointRepository,
    EndpointHistory,
    DeliveryLog,
    BreakerStore,
    DeliveryQueue,
    OutboundHttp,
    RandomSource,
    WEBHOOK_NET_OPTIONS,
    AddressGuard,
    RoutingReceipts,
    WebhookSubscriptions,
    WebhookRoutingService,
    WebhookDeliveryService,
    WebhookLifecycleService,
  ],
})
export class WebhooksCoreModule {}
