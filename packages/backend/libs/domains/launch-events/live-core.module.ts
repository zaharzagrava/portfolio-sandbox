import { Module } from '@nestjs/common';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { LiveService } from './application/live.service';

/** LiveService without HTTP (used by the projector's async moderation too). */
@Module({
  imports: [RealtimeModule, KafkaProducerModule],
  providers: [LiveService],
  exports: [LiveService],
})
export class LiveCoreModule {}
