import { Module } from '@nestjs/common';
import { RealtimeModule } from '@app/infrastructure/realtime/realtime.module';
import { ExportJobTopics } from './api/realtime-topics';

/** Registers this domain's realtime topics in the SSE gateway (imported there; debt D-3). */
@Module({ imports: [RealtimeModule], providers: [ExportJobTopics] })
export class ExportJobTopicsModule {}
