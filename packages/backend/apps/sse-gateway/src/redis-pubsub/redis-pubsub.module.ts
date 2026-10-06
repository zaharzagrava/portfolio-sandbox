import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { RedisPubSubService } from './redis-pubsub.service';

@Module({
  imports: [ApiConfigModule],
  providers: [RedisPubSubService],
  exports: [RedisPubSubService],
})
export class RedisPubSubModule {}
