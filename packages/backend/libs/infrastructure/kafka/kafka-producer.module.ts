import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { KafkaProducerService } from './kafka-producer.service';

@Module({
  imports: [ApiConfigModule],
  providers: [KafkaProducerService],
  exports: [KafkaProducerService],
})
export class KafkaProducerModule {}
