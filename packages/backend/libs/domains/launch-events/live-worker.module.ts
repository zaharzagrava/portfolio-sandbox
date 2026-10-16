import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/config';
import { CacheModule } from '@app/infrastructure/cache';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { LIVE_TOPIC } from './application/events/live-events';
import { LiveEventLog } from './application/live-event-log';
import { LiveMutes } from './application/live-mutes.service';
import { LiveStateCache } from './application/live-state-cache';
import './application/live.job-types';
import {
  LiveReconcileJob,
  LiveReconcileSchedule,
} from './infra/live-reconcile.job';
import { LiveTicker } from './infra/live-ticker.service';
import LiveMute from './infra/models/live-mute.model';
import LiveStream from './infra/models/live-stream.model';
import {
  LIVE_FAST_STORE_ADAPTERS,
  LIVE_STREAM_ADAPTERS,
  LIVE_SUPPORT_PROVIDERS,
} from './live.providers';

/**
 * S23 (worker): the per-second statistics publisher and the 30-second reconcile job. Boots on its own: everything it
 * needs is listed here (L-018).
 */
@Module({
  imports: [
    ApiConfigModule,
    CacheModule,
    ClockModule,
    JobsModule,
    RealtimeModule,
    EventsModule.forAggregates([LIVE_TOPIC]),
    SequelizeModule.forFeature([LiveStream, LiveMute]),
  ],
  providers: [
    ...LIVE_STREAM_ADAPTERS,
    ...LIVE_FAST_STORE_ADAPTERS,
    ...LIVE_SUPPORT_PROVIDERS,
    LiveStateCache,
    LiveEventLog,
    LiveMutes,
    LiveTicker,
    LiveReconcileJob,
    LiveReconcileSchedule,
  ],
})
export class LiveWorkerModule {}
