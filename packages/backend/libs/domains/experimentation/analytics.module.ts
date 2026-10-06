import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { AnalyticsService } from './application/analytics.service';
import { AnalyticsController } from './api/analytics.controller';

/** SD-31 (core): ingest fallback, assignments, experiment admin + results. */
@Module({
  imports: [AuthModule, KafkaProducerModule, ClickHouseModule, CacheModule],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
  controllers: [AnalyticsController],
})
export class AnalyticsModule {}
