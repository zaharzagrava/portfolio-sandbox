import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { DbUtilsModule } from '@app/infrastructure/database/db-utils/db-utils.module';
import { OutboxDtoModule } from '@app/infrastructure/outbox/dto/outbox-dto.module';
import { OutboxModule } from '@app/infrastructure/outbox/outbox.module';
import { KafkaConsumerService } from './kafka-consumer.service';

@Module({
  imports: [ApiConfigModule, DbUtilsModule, OutboxDtoModule, OutboxModule],
  providers: [KafkaConsumerService],
  exports: [KafkaConsumerService],
})
export class KafkaConsumerModule {}
