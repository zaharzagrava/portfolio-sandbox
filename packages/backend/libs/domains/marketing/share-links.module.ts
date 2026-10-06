import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { ShareLinkService } from './application/share-link.service';
import { ShareLinksController } from './api/share-links.controller';

/** SD-08 (core). Needs global Redis, Dynamo, Cache modules. */
@Module({
  imports: [AuthModule, KafkaProducerModule, ClickHouseModule],
  providers: [ShareLinkService],
  exports: [ShareLinkService],
  controllers: [ShareLinksController],
})
export class ShareLinksModule {}
