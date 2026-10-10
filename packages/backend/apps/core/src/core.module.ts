import { ShopFunctionsModule } from '@app/domains/shop-functions';
import { KnowledgeModule } from '@app/domains/assistant';
import { OnboardingModule } from '@app/domains/seller-onboarding';
import {
  CrawlerModule,
  LeaderboardsModule,
  SellerStatsModule,
} from '@app/domains/seller-insights';
import {
  IntegrationsModule,
  CatalogImportModule,
  OfflineSyncModule,
} from '@app/domains/catalog-sync';
import { VideoModule, MediaModule } from '@app/domains/media';
import { AssetsModule } from '@app/domains/asset-library';
import { StoriesModule } from '@app/domains/content';
import {
  WidgetModule,
  WebhooksModule,
  DevelopersModule,
} from '@app/domains/developer-platform';
import {
  TrendingModule,
  RecommendationsModule,
  SearchAdminModule,
  AutocompleteModule,
} from '@app/domains/discovery';
import { AdsModule, ShareLinksModule } from '@app/domains/marketing';
import {
  AnalyticsModule,
  FlagsSdkModule,
  FlagsAdminModule,
} from '@app/domains/experimentation';
import { DeliveryModule, PickupModule } from '@app/domains/fulfilment';
import {
  DraftsModule,
  ProductBatchReadModule,
  ProductModule,
} from '@app/domains/catalog';
import { ChatSyncModule, ChatModule } from '@app/domains/chat';
import { LiveModule, LaunchEventsModule } from '@app/domains/launch-events';
import { NotificationsModule } from '@app/domains/notifications';
import { FeedModule, DiscussionsModule } from '@app/domains/community';
import { StatementsModule } from '@app/domains/statements';
import { BillingModule } from '@app/domains/billing';
import { AuctionsModule } from '@app/domains/auctions';
import { FinanceModule } from '@app/domains/payments';
import { OrdersModule } from '@app/domains/orders';
import { ShopBatchReadModule, TenancyModule } from '@app/domains/tenancy';
import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from '@app/common/exceptions-filter';
import { ScheduleModule } from '@nestjs/schedule';
import { ApiConfigService, ApiConfigModule } from '@app/common/config';

import { PlatformModule } from '@app/infrastructure/platform';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { DynamoModule } from '@app/infrastructure/dynamo/dynamo.module';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { ErrorUtilsModule } from '@app/common/errors/error-utils/error-utils.module';
import { AdminModule, UsersModule, AuthApiModule } from '@app/domains/identity';
import { AppController } from './app.controller';
import { Environment } from '@app/common/types';
import { SentryModule } from '@sentry/nestjs/setup';
import { AppService } from './app.service';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { OpenTelemetryModule } from 'nestjs-otel';
import { PaymentQueryModule } from './payment-query/payment-query.module';
import { OutboxPublisherModule } from '@app/infrastructure/outbox/outbox-publisher.module';

/**
 * Everything with no distinguishing latency/resource profile lives here by
 * default: ordinary request/response HTTP (auth, users, admin, product
 * search+create, payment reads, seller stats) plus the outbox mailman — cheap
 * polling against your own Postgres, same as everything else in this app.
 * Stripe (payment-processor), SSE (sse-gateway) and read-model projections
 * (projector, scaled on Kafka lag - F-05) get split out, because those have
 * real reasons to.
 */
@Module({
  imports: [
    ApiConfigModule,
    PlatformModule,
    RedisModule,
    DynamoModule,
    CacheModule,
    // SD-28: one limiter for the whole app - default.read / default.write on every route, @RateLimit for the rest.
    RateLimitModule.forRoot(),
    SequelizeModule.forRootAsync({
      imports: [ApiConfigModule],
      inject: [ApiConfigService],
      useFactory: (configService: ApiConfigService) => ({
        dialect: 'postgres',
        host: configService.get('db_host'),
        port: Number(configService.get('db_port')),
        username: configService.get('db_username'),
        password: configService.get('db_password'),
        database: configService.get('db_name'),
        autoLoadModels: true,
        synchronize: false,
        logging: false,
        ...(configService.get('node_env') === Environment.production && {
          dialectOptions: {
            ssl: {
              require: true,
              rejectUnauthorized: false,
            },
          },
        }),
      }),
    }),
    ScheduleModule.forRoot(),
    ErrorUtilsModule,
    AdminModule,
    AuthApiModule,
    UsersModule,
    SentryModule.forRoot(),
    ProductModule,
    ClickHouseModule,
    PaymentQueryModule,
    OutboxPublisherModule,
    ChatModule,
    TenancyModule,
    OrdersModule,
    FinanceModule,
    LaunchEventsModule,
    AuctionsModule,
    BillingModule,
    StatementsModule,
    DiscussionsModule,
    FeedModule,
    ShareLinksModule,
    AutocompleteModule,
    PickupModule,
    SearchAdminModule,
    RecommendationsModule,
    NotificationsModule,
    LiveModule,
    LeaderboardsModule,
    ChatSyncModule,
    DraftsModule,
    DeliveryModule,
    DevelopersModule,
    WebhooksModule,
    FlagsSdkModule,
    FlagsAdminModule,
    AnalyticsModule,
    TrendingModule,
    AdsModule,
    WidgetModule,
    ShopBatchReadModule,
    ProductBatchReadModule,
    StoriesModule,
    OfflineSyncModule,
    MediaModule,
    CatalogImportModule,
    KnowledgeModule,
    OnboardingModule,
    AssetsModule,
    VideoModule,
    IntegrationsModule,
    CrawlerModule,
    ShopFunctionsModule,
    SellerStatsModule,
    OpenTelemetryModule.forRoot({
      metrics: {
        hostMetrics: true,
      },
    }),
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
    AppService,
  ],
})
export class CoreModule {}
