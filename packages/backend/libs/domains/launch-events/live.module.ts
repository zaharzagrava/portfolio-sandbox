import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/config';
import { ProblemCatalogModule } from '@app/common/errors';
import { ProductQueryModule } from '@app/domains/catalog';
import { AuthModule } from '@app/domains/identity';
import { CacheModule } from '@app/infrastructure/cache';
import { DynamoModule } from '@app/infrastructure/dynamo/dynamo.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { LiveHistoryController } from './api/live-history.controller';
import { LiveStaffController } from './api/live-staff.controller';
import { LiveViewerController } from './api/live-viewer.controller';
import { LAUNCH_EVENTS_TOPIC } from './application/events/launch-event-events';
import { LIVE_TOPIC } from './application/events/live-events';
import { LIVE_PROBLEMS } from './domain/live-errors';
import LiveMute from './infra/models/live-mute.model';
import LiveStream from './infra/models/live-stream.model';
import {
  LIVE_FAST_STORE_ADAPTERS,
  LIVE_HISTORY_ADAPTERS,
  LIVE_SERVICES,
  LIVE_STREAM_ADAPTERS,
  LIVE_SUPPORT_PROVIDERS,
} from './live.providers';
import { launchEventsRatePolicies } from './rate-limit-policies';

/** S23 live stream (core): the HTTP routes. Boots on its own: everything it needs is listed here (L-018). */
@Module({
  imports: [
    ApiConfigModule,
    AuthModule,
    CacheModule,
    ClockModule,
    DynamoModule,
    ProductQueryModule,
    RealtimeModule,
    EventsModule.forAggregates([LIVE_TOPIC, LAUNCH_EVENTS_TOPIC]),
    RateLimitModule.forFeature(launchEventsRatePolicies),
    ProblemCatalogModule.forFeature(LIVE_PROBLEMS),
    SequelizeModule.forFeature([LiveStream, LiveMute]),
  ],
  providers: [
    ...LIVE_STREAM_ADAPTERS,
    ...LIVE_FAST_STORE_ADAPTERS,
    ...LIVE_HISTORY_ADAPTERS,
    ...LIVE_SUPPORT_PROVIDERS,
    ...LIVE_SERVICES,
  ],
  controllers: [
    LiveStaffController,
    LiveViewerController,
    LiveHistoryController,
  ],
})
export class LiveModule {}
