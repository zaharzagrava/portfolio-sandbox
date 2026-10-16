import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { ConsumerAdminService } from './consumer-admin.service';
import { ConsumerLag } from './consumer-lag';
import { ConsumerPauseFlags } from './consumer-pause';
import { ProjectionRegistry } from './projection-registry';
import { RedriveService } from './redrive.service';

/** What the consumer operator routes need (no consumer is started): mounted by the identity operator module. */
@Module({
  imports: [ApiConfigModule, RedisModule, KafkaProducerModule],
  providers: [
    ConsumerAdminService,
    ConsumerLag,
    ConsumerPauseFlags,
    ProjectionRegistry,
    RedriveService,
  ],
  exports: [ConsumerAdminService],
})
export class ConsumerAdminModule {}
