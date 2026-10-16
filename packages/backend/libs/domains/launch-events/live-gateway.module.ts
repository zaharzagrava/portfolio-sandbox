import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/config';
import { ProblemCatalogModule } from '@app/common/errors';
import { AuthModule } from '@app/domains/identity';
import { CacheModule } from '@app/infrastructure/cache';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { LiveLimits } from './application/live-limits';
import { LiveSnapshotService } from './application/live-snapshot.service';
import { LiveStateCache } from './application/live-state-cache';
import { LIVE_PROBLEMS } from './domain/live-errors';
import { LiveStreamController } from './gateway/live-stream.controller';
import { LiveViewerRegistry } from './gateway/live-viewer-registry';
import LiveStream from './infra/models/live-stream.model';
import {
  LIVE_FAST_STORE_ADAPTERS,
  LIVE_STREAM_ADAPTERS,
  LIVE_SUPPORT_PROVIDERS,
} from './live.providers';
import { launchEventsRatePolicies } from './rate-limit-policies';
import LiveMute from './infra/models/live-mute.model';

/**
 * S23 delivery tier (sse-gateway): the event connection, the per-stream sampler and the viewer registry. Boots on its own:
 * everything it needs is listed here (L-018).
 */
@Module({
  imports: [
    ApiConfigModule,
    AuthModule,
    CacheModule,
    ClockModule,
    RealtimeModule,
    RateLimitModule.forFeature(launchEventsRatePolicies),
    ProblemCatalogModule.forFeature(LIVE_PROBLEMS),
    SequelizeModule.forFeature([LiveStream, LiveMute]),
  ],
  providers: [
    ...LIVE_STREAM_ADAPTERS,
    ...LIVE_FAST_STORE_ADAPTERS,
    ...LIVE_SUPPORT_PROVIDERS,
    LiveLimits,
    LiveStateCache,
    LiveSnapshotService,
    LiveViewerRegistry,
  ],
  controllers: [LiveStreamController],
})
export class LiveGatewayModule {}
