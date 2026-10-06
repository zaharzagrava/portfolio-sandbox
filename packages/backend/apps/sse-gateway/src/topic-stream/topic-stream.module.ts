import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { AuthModule } from '@app/domains/identity';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { RealtimeModule } from '@app/infrastructure/realtime/realtime.module';
import { SubscriptionHub } from './subscription-hub.service';
import { TopicStreamController } from './topic-stream.controller';

@Module({
  imports: [ApiConfigModule, AuthModule, RedisModule, RealtimeModule],
  providers: [SubscriptionHub],
  controllers: [TopicStreamController],
  exports: [SubscriptionHub],
})
export class TopicStreamModule {}
