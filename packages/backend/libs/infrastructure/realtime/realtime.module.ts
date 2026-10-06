import { Global, Module } from '@nestjs/common';
import { RealtimePublisher } from './realtime-publisher.service';
import { TopicRegistry } from './topic-registry';

/** Requires RedisModule (global) in the importing app. */
@Global()
@Module({
  providers: [RealtimePublisher, TopicRegistry],
  exports: [RealtimePublisher, TopicRegistry],
})
export class RealtimeModule {}
