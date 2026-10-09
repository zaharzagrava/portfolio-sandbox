import { Module } from '@nestjs/common';
import { RedisPubSubService } from './redis-pubsub.service';
import { ApiConfigModule } from '@app/common/config';

@Module({
  imports: [ApiConfigModule],
  providers: [RedisPubSubService],
  exports: [RedisPubSubService],
})
export class RedisPubSubModule {}
