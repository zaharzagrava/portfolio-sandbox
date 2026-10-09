import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { LedgerModule } from '@app/domains/payments';
import { AdsService } from './application/ads.service';
import { AdsController } from './api/ads.controller';
import { AdBillingJobs } from './infra/ad-billing.jobs';
import { ClickAggregator } from './infra/click-aggregator.service';

/** SD-32 ads serving + click endpoint (core). */
@Module({
  imports: [AuthModule, KafkaProducerModule],
  providers: [AdsService],
  exports: [AdsService],
  controllers: [AdsController],
})
export class AdsModule {}

/** SD-32 exactly-once click aggregation + billing/reconciliation (apps/worker). */
@Module({
  imports: [ClickHouseModule, JobsModule, LedgerModule],
  providers: [ClickAggregator, AdBillingJobs],
  exports: [AdBillingJobs],
})
export class AdsWorkerModule {}
