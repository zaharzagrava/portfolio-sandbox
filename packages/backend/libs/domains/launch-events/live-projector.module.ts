import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/config';
import { DynamoModule } from '@app/infrastructure/dynamo/dynamo.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { LIVE_TOPIC } from './application/events/live-events';
import { LiveEventLog } from './application/live-event-log';
import { LiveRemovalService } from './application/live-removal.service';
import {
  COMMENT_HISTORY_READER,
  LIVE_SETTINGS,
  LIVE_STREAMS,
  RECENT_COMMENT_STORE,
  REMOVAL_CLAIMS,
  TOXICITY_CLASSIFIER,
} from './domain/live-ports';
import { LiveCommentsProjector } from './infra/live-comments.projector';
import { LiveModerationConsumer } from './infra/live-moderation.consumer';
import LiveMute from './infra/models/live-mute.model';
import LiveStream from './infra/models/live-stream.model';
import {
  LIVE_FAST_STORE_ADAPTERS,
  LIVE_HISTORY_ADAPTERS,
  LIVE_STREAM_ADAPTERS,
  LIVE_SUPPORT_PROVIDERS,
} from './live.providers';

/**
 * S23 (projector): the history writer and the asynchronous moderation consumer (apps/projector registers them from
 * `projectors`, each in its own consumer group). The projection framework builds the consumers in its own module, so what
 * they inject is exported. Boots on its own (L-018).
 */
@Module({
  imports: [
    ApiConfigModule,
    ClockModule,
    DynamoModule,
    RealtimeModule,
    EventsModule.forAggregates([LIVE_TOPIC]),
    SequelizeModule.forFeature([LiveStream, LiveMute]),
  ],
  providers: [
    ...LIVE_STREAM_ADAPTERS,
    ...LIVE_FAST_STORE_ADAPTERS,
    ...LIVE_HISTORY_ADAPTERS,
    ...LIVE_SUPPORT_PROVIDERS,
    LiveEventLog,
    LiveRemovalService,
  ],
  exports: [
    LiveRemovalService,
    DynamoModule,
    ClockModule,
    TOXICITY_CLASSIFIER,
    LIVE_SETTINGS,
    LIVE_STREAMS,
    RECENT_COMMENT_STORE,
    REMOVAL_CLAIMS,
    COMMENT_HISTORY_READER,
  ],
})
export class LiveProjectorModule {
  static readonly projectors = [LiveCommentsProjector, LiveModerationConsumer];
}
