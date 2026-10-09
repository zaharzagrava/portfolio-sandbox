import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { KAFKA_CLIENT_OVERRIDES } from './kafka-client.options';
import { KafkaProducerService } from './kafka-producer.service';

@Module({
  imports: [ApiConfigModule],
  providers: [
    // Empty in production; specs override it (socket factory through the TCP fault proxy).
    { provide: KAFKA_CLIENT_OVERRIDES, useValue: {} },
    KafkaProducerService,
  ],
  exports: [KafkaProducerService],
})
export class KafkaProducerModule {}
