import { Module } from '@nestjs/common';
import { RealtimeModule } from '@app/infrastructure/realtime/realtime.module';
import { IdentityTopics } from './api/realtime-topics';

/** Registers this domain's realtime topics in the SSE gateway (imported there; debt D-3). */
@Module({ imports: [RealtimeModule], providers: [IdentityTopics] })
export class IdentityTopicsModule {}
