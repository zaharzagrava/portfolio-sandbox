import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/config';
import { AuthModule } from '@app/domains/identity';
import { CacheModule } from '@app/infrastructure/cache';
import { DynamoModule } from '@app/infrastructure/dynamo/dynamo.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { LAUNCH_EVENTS_TOPIC } from './application/events/launch-event-events';
import './application/launch-event.job-types';
import Booking from './infra/models/booking.model';
import BookingEvent from './infra/models/booking-event.model';
import LaunchEvent from './infra/models/launch-event.model';
import LaunchEventHistory from './infra/models/launch-event-history.model';
import { Admitter, LAUNCH_ADMITTER_OPTIONS } from './infra/admitter';
import {
  LaunchEventJobs,
  LaunchEventSchedule,
} from './infra/jobs/launch-event.jobs';
import { LAUNCH_ADAPTERS, LAUNCH_SERVICES } from './launch-events.providers';
import { launchEventsRatePolicies } from './rate-limit-policies';

/**
 * S22 booking (worker): the admitter (one second tick, per event only the lease holder acts), the four jobs and the
 * every-minute reconcile schedule. Boots on its own: everything it needs is listed here (L-018).
 */
@Module({
  imports: [
    ApiConfigModule,
    AuthModule,
    CacheModule,
    ClockModule,
    DynamoModule,
    JobsModule,
    RealtimeModule,
    EventsModule.forAggregates([LAUNCH_EVENTS_TOPIC]),
    RateLimitModule.forFeature(launchEventsRatePolicies),
    SequelizeModule.forFeature([
      LaunchEvent,
      LaunchEventHistory,
      Booking,
      BookingEvent,
    ]),
  ],
  providers: [
    ...LAUNCH_ADAPTERS,
    ...LAUNCH_SERVICES,
    { provide: LAUNCH_ADMITTER_OPTIONS, useValue: { autoStart: true } },
    Admitter,
    LaunchEventJobs,
    LaunchEventSchedule,
  ],
})
export class LaunchEventsWorkerModule {}
