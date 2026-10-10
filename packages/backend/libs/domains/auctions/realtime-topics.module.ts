import { Module } from '@nestjs/common';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { AuctionTopics } from './api/realtime-topics';

/** Registers this domain's realtime topics in the SSE gateway (imported there; debt D-3). */
@Module({ imports: [RealtimeModule], providers: [AuctionTopics] })
export class AuctionTopicsModule {}
