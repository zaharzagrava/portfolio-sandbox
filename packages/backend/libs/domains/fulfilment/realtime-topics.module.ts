import { Module } from '@nestjs/common';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { DeliveryTopics } from './api/realtime-topics';
import { REALTIME_ACCESS_PORT } from './domain/delivery-ports';
import { RealtimeAccessSqlAdapter } from './infra/realtime-access.adapter';

/** Registers this domain's realtime topics in the SSE gateway (imported there; debt D-3). */
@Module({
  imports: [RealtimeModule],
  providers: [
    { provide: REALTIME_ACCESS_PORT, useClass: RealtimeAccessSqlAdapter },
    DeliveryTopics,
  ],
})
export class DeliveryTopicsModule {}
