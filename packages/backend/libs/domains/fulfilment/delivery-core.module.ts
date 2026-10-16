import { Module } from '@nestjs/common';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { CourierService } from './application/courier.service';
import { DeliveryActionsService } from './application/delivery-actions.service';
import { DeliveryPushService } from './application/delivery-push.service';
import { DELIVERY_AGGREGATE } from './application/events/delivery-events';
import { DispatchService } from './application/dispatch.service';
import { LocationIngestService } from './application/location-ingest.service';
import { OrderWriteBackScheduler } from './application/order-lifecycle.service';
import { DeliveryOwnership } from './application/delivery-ownership.service';
import { RecoveryService } from './application/recovery.service';
import { SurgeService } from './application/surge.service';
import {
  COURIER_OFFLINE_HOOK,
  COURIER_REPOSITORY,
  DELIVERABLE_ORDER_STORE,
  DELIVERY_REPOSITORY,
  DISPATCH_TIMERS,
  GEO_INDEX,
  OFFER_GUARD,
  OFFER_REPOSITORY,
  POSITION_THROTTLE,
  RING_REGISTRY,
  SURGE_STORE,
} from './domain/delivery-ports';
import { CourierSqlRepository } from './infra/courier.repository';
import { DeliverableOrderSqlRepository } from './infra/deliverable-order.repository';
import { DeliverySqlRepository } from './infra/delivery.repository';
import { SqsDispatchTimers } from './infra/dispatch-timers';
import { RedisGeoIndex } from './infra/geo-index';
import { RedisOfferGuard } from './infra/offer-guard';
import { OfferSqlRepository } from './infra/offer.repository';
import { RedisPositionThrottle } from './infra/position-throttle';
import { RedisRingRegistry } from './infra/ring-registry';
import { RedisSurgeStore } from './infra/surge-store';
// The job contracts must be declared wherever a job of this capability is enqueued (the write-back) or handled.
import './infra/delivery-jobs';

/**
 * The delivery application services and the adapters behind their ports, shared by the HTTP side (`DeliveryModule`),
 * the worker (`DeliveryWorkerModule`) and the consumers (`DeliveryProjectorModule`). The adapters of the order write-back
 * port and the queue and job handlers live in the worker module; later phases add the surge and ring adapters here.
 */
@Module({
  imports: [
    ClockModule,
    RealtimeModule,
    KafkaProducerModule,
    SqsModule,
    JobsModule,
    EventsModule.forAggregates([DELIVERY_AGGREGATE]),
  ],
  providers: [
    { provide: COURIER_REPOSITORY, useClass: CourierSqlRepository },
    { provide: DELIVERY_REPOSITORY, useClass: DeliverySqlRepository },
    { provide: OFFER_REPOSITORY, useClass: OfferSqlRepository },
    {
      provide: DELIVERABLE_ORDER_STORE,
      useClass: DeliverableOrderSqlRepository,
    },
    { provide: GEO_INDEX, useClass: RedisGeoIndex },
    { provide: OFFER_GUARD, useClass: RedisOfferGuard },
    { provide: SURGE_STORE, useClass: RedisSurgeStore },
    { provide: POSITION_THROTTLE, useClass: RedisPositionThrottle },
    { provide: RING_REGISTRY, useClass: RedisRingRegistry },
    { provide: DISPATCH_TIMERS, useClass: SqsDispatchTimers },
    { provide: COURIER_OFFLINE_HOOK, useExisting: DispatchService },
    CourierService,
    LocationIngestService,
    DeliveryPushService,
    OrderWriteBackScheduler,
    DispatchService,
    DeliveryActionsService,
    RecoveryService,
    DeliveryOwnership,
    SurgeService,
  ],
  exports: [
    COURIER_REPOSITORY,
    DELIVERY_REPOSITORY,
    OFFER_REPOSITORY,
    DELIVERABLE_ORDER_STORE,
    GEO_INDEX,
    OFFER_GUARD,
    SURGE_STORE,
    DISPATCH_TIMERS,
    CourierService,
    LocationIngestService,
    DeliveryPushService,
    OrderWriteBackScheduler,
    DispatchService,
    DeliveryActionsService,
    RecoveryService,
    DeliveryOwnership,
    SurgeService,
    RING_REGISTRY,
  ],
})
export class DeliveryCoreModule {}
