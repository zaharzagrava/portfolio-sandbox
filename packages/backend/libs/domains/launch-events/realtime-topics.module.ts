import { Module } from '@nestjs/common';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { LaunchEventTopics } from './api/realtime-topics';

/** Registers this domain's realtime topics in the SSE gateway (imported there; debt D-3). */
@Module({ imports: [RealtimeModule], providers: [LaunchEventTopics] })
export class LaunchEventTopicsModule {}
