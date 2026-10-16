import { Module } from '@nestjs/common';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { LiveTopics } from './api/live-topics';

/** Registers the live stream's realtime topic in the SSE gateway (imported there; debt D-3). Needs only Redis. */
@Module({
  imports: [RealtimeModule],
  providers: [LiveTopics],
})
export class LiveTopicsModule {}
