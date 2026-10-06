import { Global, Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { CassandraModule } from '@app/infrastructure/cassandra/cassandra.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { FeedService } from './application/feed.service';
import { FeedPublisher } from './application/feed-publisher.service';
import { FeedController } from './api/feed.controller';

/** SD-09 (core). Global so content modules (discussions, drops) can publish feed items. */
@Global()
@Module({
  imports: [AuthModule, CassandraModule, KafkaProducerModule],
  providers: [FeedService, FeedPublisher],
  exports: [FeedService, FeedPublisher],
  controllers: [FeedController],
})
export class FeedModule {}
