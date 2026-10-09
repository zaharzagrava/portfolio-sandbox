import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { KafkaProducerService } from './kafka-producer.service';

@Module({
  imports: [ApiConfigModule],
  providers: [KafkaProducerService],
  exports: [KafkaProducerService],
})
export class KafkaProducerModule {}
