import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { DynamoModule } from '@app/infrastructure/dynamo/dynamo.module';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { ShopTopicsModule, TenancyModule } from '@app/domains/tenancy';
import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from '@app/common/exceptions-filter';
import { ApiConfigService, ApiConfigModule } from '@app/common/config';

import { PlatformModule } from '@app/infrastructure/platform';
import { ErrorUtilsModule } from '@app/common/errors/error-utils/error-utils.module';
import { Environment } from '@app/common/types';
import { SentryModule } from '@sentry/nestjs/setup';
import { OpenTelemetryModule } from 'nestjs-otel';
import { RealtimeNotifierModule } from './realtime-notifier/realtime-notifier.module';
import { RealtimeStreamModule } from '@app/infrastructure/realtime';
import { LiveGatewayModule } from './live/live-gateway.module';
import { IdentityTopicsModule } from '@app/domains/identity';
import { AuctionTopicsModule } from '@app/domains/auctions';
import { LaunchEventTopicsModule } from '@app/domains/launch-events';
import { FlagTopicsModule } from '@app/domains/experimentation';
import { ChatTopicsModule } from '@app/domains/chat';
import { DeliveryTopicsModule } from '@app/domains/fulfilment';
import { ImportJobTopicsModule } from '@app/domains/catalog-sync';
import { ExportJobTopicsModule } from '@app/domains/orders';
import { AssistantModule } from '@app/domains/assistant';
import { AssetTopicsModule } from '@app/domains/asset-library';

/**
 * SSE-only: the only thing here is bridging Kafka payment-status events to
 * long-lived browser connections. No auth/admin/product/etc — that's core's
 * job. Isolated because its resource profile (concurrent held-open
 * connections) is genuinely different from ordinary request/response HTTP.
 */
@Module({
  imports: [
    ApiConfigModule,
    PlatformModule,
    // Global ShopGuard/MembershipService: AssistantModule pulls in ProductModule/PickupModule with guarded controllers.
    TenancyModule,
    // Global stores the shared domain modules expect (core imports the same set).
    RedisModule,
    DynamoModule,
    CacheModule,
    JobsModule,
    SqsModule,
    StorageModule,
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
    ErrorUtilsModule,
    SentryModule.forRoot(),
    RealtimeNotifierModule,
    RealtimeStreamModule,
    LiveGatewayModule,
    // Realtime topics each domain owns (debt D-3): the gateway authorizes subscriptions, so it loads them all.
    IdentityTopicsModule,
    ShopTopicsModule,
    AssetTopicsModule,
    AuctionTopicsModule,
    LaunchEventTopicsModule,
    FlagTopicsModule,
    ChatTopicsModule,
    DeliveryTopicsModule,
    ImportJobTopicsModule,
    ExportJobTopicsModule,
    // SD-42: LLM replies are long-held streams too.
    AssistantModule,
    OpenTelemetryModule.forRoot({
      metrics: {
        hostMetrics: true,
      },
    }),
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class SseGatewayModule {}
