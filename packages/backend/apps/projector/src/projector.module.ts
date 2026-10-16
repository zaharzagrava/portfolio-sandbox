import {
  IntegrationsProjectorModule,
  OfflineSyncProjectorModule,
} from '@app/domains/catalog-sync';
import { StoryCacheInvalidator, StoryCacheModule } from '@app/domains/content';
import { StatementsProjectorModule } from '@app/domains/statements';
import {
  TrendingProjectorModule,
  RecommendationsProjectorModule,
  SearchProjectorModule,
} from '@app/domains/discovery';
import { AnalyticsProjectorModule } from '@app/domains/experimentation';
import {
  WebhooksProjectorModule,
  PublicApiProjectorModule,
  WidgetProjectorModule,
} from '@app/domains/developer-platform';
import {
  CourierTrackProjector,
  PickupProjectorModule,
} from '@app/domains/fulfilment';
import { ChatProjectorModule } from '@app/domains/chat';
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
import { NotificationsProjectorModule } from '@app/domains/notifications';
import {
  AdsProjectorModule,
  ShareLinksProjectorModule,
} from '@app/domains/marketing';
import { MediaProjectorModule, VideoProjectorModule } from '@app/domains/media';
import {
  FeedFanoutConsumer,
  ProductFeedProjector,
  FeedPublisherModule,
} from '@app/domains/community';
import { CassandraModule } from '@app/infrastructure/cassandra/cassandra.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { BillingConsumerModule } from '@app/domains/billing';
import {
  AssistantProjectorModule,
  KnowledgeProjectorModule,
} from '@app/domains/assistant';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import {
  LedgerProjectorModule,
  paymentsProjectors,
} from '@app/domains/payments';
import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { OpenTelemetryModule } from 'nestjs-otel';
import { ApiConfigModule } from '@app/common/config';
import { ErrorUtilsModule } from '@app/common/errors/error-utils/error-utils.module';
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
    // bootstrap-http looks up RouteTable; Nest aborts the process when it is missing (the try/catch there cannot stop it), so the standalone projector did not boot
    ErrorUtilsModule,
    PlatformModule,
    DatabaseModule,
    RedisModule,
    ElasticsearchModule,
    CacheModule,
    ClickHouseModule,
    CassandraModule,
    KafkaProducerModule,
    TrendingProjectorModule,
    ProjectionsModule.forProjectors(
      [
        ...ProductProjectorModule.projectors,
        ...SearchProjectorModule.projectors,
        ...paymentsProjectors,
        ...BillingConsumerModule.projectors,
        FeedFanoutConsumer,
        ProductFeedProjector,
        ...ShareLinksProjectorModule.projectors,
        ...AdsProjectorModule.projectors,
        ...MediaProjectorModule.projectors,
        ...VideoProjectorModule.projectors,
        ...PickupProjectorModule.projectors,
        ...RecommendationsProjectorModule.projectors,
        ...NotificationsProjectorModule.projectors,
        LiveCommentsProjector,
        LiveModerationConsumer,
        LeaderboardProjector,
        ShopLiveProjector,
        ShopSalesProjector,
        ...ChatProjectorModule.projectors,
        CourierTrackProjector,
        ...PublicApiProjectorModule.projectors,
        ...WidgetProjectorModule.projectors,
        ...WebhooksProjectorModule.projectors,
        ...AnalyticsProjectorModule.projectors,
        StoryCacheInvalidator,
        ...IntegrationsProjectorModule.projectors,
        ...OfflineSyncProjectorModule.projectors,
        ...AssistantProjectorModule.projectors,
        ...KnowledgeProjectorModule.projectors,
        ...StatementsProjectorModule.projectors,
      ],
      [
        ProductProjectorModule,
        SearchProjectorModule,
        RecommendationsProjectorModule,
        PickupProjectorModule,
        ShareLinksProjectorModule,
        AdsProjectorModule,
        MediaProjectorModule,
        VideoProjectorModule,
        ChatProjectorModule,
        AssistantProjectorModule,
        KnowledgeProjectorModule,
        StatementsProjectorModule,
        BillingConsumerModule,
        LedgerProjectorModule,
        AnalyticsProjectorModule,
        IntegrationsProjectorModule,
        OfflineSyncProjectorModule,
        StoryCacheModule,
        WebhooksProjectorModule,
        PublicApiProjectorModule,
        WidgetProjectorModule,
        SqsModule,
        LiveCoreModule,
        DynamoModule,
        NotificationsProjectorModule,
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
