import { Module } from '@nestjs/common';
import { RealtimeModule } from '@app/infrastructure/realtime/realtime.module';
import { ShopTopics } from './api/realtime-topics';

/** Registers `shop:{id}:live` in the SSE gateway (imported there; debt D-3). `ShopAccessService` comes from the global TenancyModule. */
@Module({
  imports: [RealtimeModule],
  providers: [ShopTopics],
})
export class ShopTopicsModule {}
