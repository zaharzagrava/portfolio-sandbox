import { Module } from '@nestjs/common';
import { CassandraModule } from '@app/infrastructure/cassandra/cassandra.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { FeedPublisher } from './application/feed-publisher.service';

/** Publishing feed items without the feed HTTP API (used by apps/projector). */
@Module({
  imports: [CassandraModule, KafkaProducerModule],
  providers: [FeedPublisher],
  exports: [FeedPublisher],
})
export class FeedPublisherModule {}
