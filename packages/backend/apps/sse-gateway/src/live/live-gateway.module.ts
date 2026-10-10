import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { LiveBatcherRegistry } from './live-batcher.service';
import { LiveStreamController } from './live-stream.controller';

/** SD-15 delivery tier (apps/sse-gateway). */
@Module({
  imports: [AuthModule, RedisModule],
  providers: [LiveBatcherRegistry],
  controllers: [LiveStreamController],
  exports: [LiveBatcherRegistry],
})
export class LiveGatewayModule {}
