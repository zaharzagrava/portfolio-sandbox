import { Module } from '@nestjs/common';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { LiveTicker } from './infra/live-ticker.service';

/** SD-15 per-second reaction / viewer aggregation (apps/worker). */
@Module({
  imports: [RealtimeModule],
  providers: [LiveTicker],
  exports: [LiveTicker],
})
export class LiveWorkerModule {}
