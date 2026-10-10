import {
  IntegrationsCoreModule,
  StockPushProjector,
} from '@app/domains/catalog-sync';
import { StoryCacheInvalidator, StoryCacheModule } from '@app/domains/content';
import {
  TrendingConsumerModule,
  OrderBasketsProjector,
  SearchClicksProjector,
  SearchQueriesProjector,
  SearchProjectorModule,
} from '@app/domains/discovery';
import { PurchaseEventsProjector } from '@app/domains/experimentation';
import {
  WebhookRouterProjector,
  WebhooksCoreModule,
  ApiRequestsProjector,
} from '@app/domains/developer-platform';
import {
  CourierTrackProjector,
  PickupAvailabilityProjector,
} from '@app/domains/fulfilment';
import { ChatOfflineScheduler } from '@app/domains/chat';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import {
  LeaderboardProjector,
  ShopLiveProjector,
  ShopSalesProjector,
} from '@app/domains/seller-insights';
import {
  LiveCommentsProjector,
  LiveModerationConsumer,
  LiveCoreModule,
} from '@app/domains/launch-events';
import { DynamoModule } from '@app/infrastructure/dynamo/dynamo.module';
import {
  NotificationRouterProjector,
  NotificationsCoreModule,
} from '@app/domains/notifications';
import { ShopMembershipModel as ShopMembership } from '@app/domains/tenancy';
import { LinkClicksProjector } from '@app/domains/marketing';
import {
  FeedFanoutConsumer,
  ProductFeedProjector,
  FeedPublisherModule,
} from '@app/domains/community';
import { CassandraModule } from '@app/infrastructure/cassandra/cassandra.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { UsageProjector } from '@app/domains/billing';
import { LlmCallsProjector } from '@app/domains/assistant';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { paymentsProjectors } from '@app/domains/payments';
import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { OpenTelemetryModule } from 'nestjs-otel';
import { ApiConfigModule } from '@app/common/config';
import { PlatformModule } from '@app/infrastructure/platform';
import { DatabaseModule } from '@app/infrastructure/database';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { ElasticsearchModule } from '@app/infrastructure/elasticsearch/elasticsearch.module';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import {
  ProductModel as Product,
  ProductProjectorModule,
} from '@app/domains/catalog';
import { CacheModule } from '@app/infrastructure/cache/cache.module';

/**
 * CQRS read-model builders (D26, F-05). Its own deployable because its
 * scaling signal is Kafka consumer lag, not HTTP traffic: the worker ASG
 * scales on `projection_lag_seconds` / consumer lag (O-03), independently of the API.
 * Sections register their projectors here as they land.
 */
@Module({
  imports: [
    ApiConfigModule,
    PlatformModule,
    DatabaseModule,
    RedisModule,
    ElasticsearchModule,
    CacheModule,
    ClickHouseModule,
    CassandraModule,
    KafkaProducerModule,
    TrendingConsumerModule,
    ProjectionsModule.forProjectors(
      [
        ...ProductProjectorModule.projectors,
        ...SearchProjectorModule.projectors,
        ...paymentsProjectors,
        UsageProjector,
        FeedFanoutConsumer,
        ProductFeedProjector,
        LinkClicksProjector,
        SearchQueriesProjector,
        PickupAvailabilityProjector,
        SearchClicksProjector,
        OrderBasketsProjector,
        NotificationRouterProjector,
        LiveCommentsProjector,
        LiveModerationConsumer,
        LeaderboardProjector,
        ShopLiveProjector,
        ShopSalesProjector,
        ChatOfflineScheduler,
        CourierTrackProjector,
        ApiRequestsProjector,
        WebhookRouterProjector,
        PurchaseEventsProjector,
        StoryCacheInvalidator,
        StockPushProjector,
        LlmCallsProjector,
      ],
      [
        ProductProjectorModule,
        SearchProjectorModule,
        IntegrationsCoreModule,
        StoryCacheModule,
        WebhooksCoreModule,
        SqsModule,
        LiveCoreModule,
        DynamoModule,
        NotificationsCoreModule,
        SequelizeModule.forFeature([ShopMembership]),
        CassandraModule,
        KafkaProducerModule,
        FeedPublisherModule,
        ClickHouseModule,
        SequelizeModule.forFeature([Product]),
        ElasticsearchModule,
      ],
    ),
    OpenTelemetryModule.forRoot({ metrics: { hostMetrics: true } }),
  ],
})
export class ProjectorModule {}
