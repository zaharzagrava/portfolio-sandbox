import { Module } from '@nestjs/common';
import { KafkaConsumerService } from './kafka-consumer.service';

/** @deprecated with `KafkaConsumerService`: removed once S13 migrates the payments flows (S53 G-27). */
@Module({
  providers: [KafkaConsumerService],
  exports: [KafkaConsumerService],
})
export class KafkaConsumerModule {}
