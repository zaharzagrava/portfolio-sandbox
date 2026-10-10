import { Module } from '@nestjs/common';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { CourierService } from './application/courier.service';
import { DispatchService } from './application/dispatch.service';

@Module({
  imports: [RealtimeModule, KafkaProducerModule, SqsModule],
  providers: [CourierService, DispatchService],
  exports: [CourierService, DispatchService],
})
export class DeliveryCoreModule {}
