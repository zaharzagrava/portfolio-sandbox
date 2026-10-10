import { Module } from '@nestjs/common';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { AssetTopics } from './api/realtime-topics';

/** Registers `shop:{id}:assets` in the SSE gateway (imported there; debt D-3). `ShopAccessService` comes from the global TenancyModule. */
@Module({ imports: [RealtimeModule], providers: [AssetTopics] })
export class AssetTopicsModule {}
