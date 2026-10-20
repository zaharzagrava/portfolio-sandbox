import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { ProductModule } from '@app/domains/catalog';
import { AuthModule } from '@app/domains/identity';
import { TenancyModule } from '@app/domains/tenancy';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { KAFKA_CONSUMER_OVERRIDES } from '@app/infrastructure/kafka/kafka-client.options';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { DeadLetterWriter } from '@app/infrastructure/projections/dead-letter';
import { ConsumerPauseFlags } from '@app/infrastructure/projections/consumer-pause';
import { ProjectionRegistry } from '@app/infrastructure/projections/projection-registry';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { TrendingController } from './api/trending.controller';
import {
  TRENDING_RANDOM,
  TrendingIngestService,
} from './application/trending-ingest.service';
import { TrendingService } from './application/trending.service';
import {
  TRENDING_AGGREGATE_READER,
  TRENDING_AGGREGATE_WRITER,
  TRENDING_CATALOG_FACTS,
  TRENDING_SETTINGS,
} from './domain/trending-ports';
import { RedisTrendingAggregateAdapter } from './infra/redis-trending-aggregate.adapter';
import { TrendingCatalogFactsAdapter } from './infra/trending-catalog-facts.adapter';
import { TrendingSettings } from './infra/trending-config';
import {
  DEFAULT_TRENDING_CONSUMER_OPTIONS,
  TRENDING_CONSUMER_OPTIONS,
  TRENDING_PROCESS_EXIT,
  TrendingConsumer,
} from './infra/trending.consumer';
import { discoveryRatePolicies } from './rate-limit-policies';

/**
 * S35 read side (core): `GET /api/trending`. Product and shop facts come from the entry points of `catalog` and `tenancy`,
 * never from their tables (D-7, D-12); the window aggregates come from this capability's own Redis store. Exports nothing.
 */
@Module({
  imports: [
    AuthModule,
    ApiConfigModule,
    CacheModule,
    ProductModule,
    TenancyModule,
    RateLimitModule.forFeature(discoveryRatePolicies),
  ],
  controllers: [TrendingController],
  providers: [
    TrendingSettings,
    { provide: TRENDING_SETTINGS, useExisting: TrendingSettings },
    TrendingService,
    RedisTrendingAggregateAdapter,
    {
      provide: TRENDING_AGGREGATE_READER,
      useExisting: RedisTrendingAggregateAdapter,
    },
    { provide: TRENDING_CATALOG_FACTS, useClass: TrendingCatalogFactsAdapter },
  ],
})
export class TrendingModule {}

/**
 * S35 count side (projector): the consumer of `analytics.events` in group `discovery-trending-topk`, the ingest service and
 * the aggregate writer. Hosted by `apps/projector`. Exports nothing.
 */
@Module({
  imports: [ApiConfigModule, KafkaProducerModule],
  providers: [
    TrendingSettings,
    { provide: TRENDING_SETTINGS, useExisting: TrendingSettings },
    RedisTrendingAggregateAdapter,
    {
      provide: TRENDING_AGGREGATE_WRITER,
      useExisting: RedisTrendingAggregateAdapter,
    },
    DeadLetterWriter,
    // The operator's view of the group: its declaration (topics) and its pause flag (S53 R-21, R-22).
    ConsumerPauseFlags,
    ProjectionRegistry,
    TrendingIngestService,
    TrendingConsumer,
    // Production values; specs bind a fresh group and topic, a process-exit spy and a scripted jitter.
    {
      provide: TRENDING_CONSUMER_OPTIONS,
      useValue: DEFAULT_TRENDING_CONSUMER_OPTIONS,
    },
    {
      provide: TRENDING_PROCESS_EXIT,
      useValue: (code: number) => process.exit(code),
    },
    { provide: TRENDING_RANDOM, useValue: Math.random },
    // Empty in production; specs bind a socket factory to cut or delay the consumer's connection (AS-40).
    { provide: KAFKA_CONSUMER_OVERRIDES, useValue: {} },
  ],
})
export class TrendingProjectorModule {}
