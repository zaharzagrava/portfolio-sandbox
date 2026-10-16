import { Module } from '@nestjs/common';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { LaunchEventTopics } from './api/realtime-topics';
import { QUEUE_STORE } from './domain/ports';
import { RedisQueueStore } from './infra/redis/redis-queue.store';

/** Registers this domain's realtime topics in the SSE gateway (imported there; debt D-3). Needs only Redis. */
@Module({
  imports: [RealtimeModule],
  providers: [
    RedisQueueStore,
    { provide: QUEUE_STORE, useExisting: RedisQueueStore },
    LaunchEventTopics,
  ],
})
export class LaunchEventTopicsModule {}
