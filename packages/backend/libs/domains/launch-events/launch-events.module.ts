import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/config';
import { ProblemCatalogModule } from '@app/common/errors';
import { AuthModule } from '@app/domains/identity';
import { CacheModule } from '@app/infrastructure/cache';
import { DynamoModule } from '@app/infrastructure/dynamo/dynamo.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { AdmissionGuard } from './api/admission.guard';
import { BuyerController } from './api/buyer.controller';
import { HoldsController } from './api/holds.controller';
import { OrganizerController } from './api/organizer.controller';
import { WaitingRoomController } from './api/waiting-room.controller';
import { LAUNCH_EVENTS_TOPIC } from './application/events/launch-event-events';
import './application/launch-event.job-types';
import { LAUNCH_EVENT_PROBLEMS } from './domain/errors';
import Booking from './infra/models/booking.model';
import BookingEvent from './infra/models/booking-event.model';
import LaunchEvent from './infra/models/launch-event.model';
import LaunchEventHistory from './infra/models/launch-event-history.model';
import { LAUNCH_ADAPTERS, LAUNCH_SERVICES } from './launch-events.providers';
import { launchEventsRatePolicies } from './rate-limit-policies';

/** S22 booking (core): the HTTP routes. Boots on its own: everything it needs is listed here (L-018). */
@Module({
  imports: [
    ApiConfigModule,
    AuthModule,
    CacheModule,
    ClockModule,
    DynamoModule,
    IdempotencyModule,
    JobsModule,
    RealtimeModule,
    EventsModule.forAggregates([LAUNCH_EVENTS_TOPIC]),
    RateLimitModule.forFeature(launchEventsRatePolicies),
    ProblemCatalogModule.forFeature(LAUNCH_EVENT_PROBLEMS),
    SequelizeModule.forFeature([
      LaunchEvent,
      LaunchEventHistory,
      Booking,
      BookingEvent,
    ]),
  ],
  providers: [...LAUNCH_ADAPTERS, ...LAUNCH_SERVICES, AdmissionGuard],
  controllers: [
    WaitingRoomController,
    HoldsController,
    OrganizerController,
    BuyerController,
  ],
})
export class LaunchEventsModule {}
