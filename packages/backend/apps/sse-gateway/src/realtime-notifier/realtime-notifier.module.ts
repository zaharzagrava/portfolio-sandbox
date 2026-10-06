import { Module } from '@nestjs/common';
import { RedisPubSubModule } from '../redis-pubsub/redis-pubsub.module';
import { RealtimeNotifierController } from './realtime-notifier.controller';

@Module({
  imports: [RedisPubSubModule],
  controllers: [RealtimeNotifierController],
})
export class RealtimeNotifierModule {}
