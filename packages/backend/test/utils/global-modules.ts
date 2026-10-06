import * as path from 'path';

import { SequelizeModule } from '@nestjs/sequelize';
import { Test } from '@nestjs/testing';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { ScheduleModule } from '@nestjs/schedule';
import { MockApiConfigServiceFactory } from '@app/common/config/api-config.service.mock';
import { ConfigUtilsService } from '@app/common/config/config-utils/config-utils.service';

import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AllExceptionsFilter } from '@app/common/exceptions-filter/exceptions-filter';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ConfigUtilsModule } from '@app/common/config/config-utils/config-utils.module';
import { ErrorUtilsModule } from '@app/common/errors/error-utils/error-utils.module';
import { RequestContextModule } from '@app/infrastructure/context/request-context.module';
import { TransactionModule } from '@app/infrastructure/context/transaction.module';
import { HealthModule } from '@app/infrastructure/health/health.module';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { CassandraModule } from '@app/infrastructure/cassandra/cassandra.module';
import { DynamoModule } from '@app/infrastructure/dynamo/dynamo.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { ElasticsearchModule } from '@app/infrastructure/elasticsearch/elasticsearch.module';
import { TestCleanupModule } from './test-cleanup.module';
import { TenancyModule } from '@app/domains/tenancy';

/**
 * Load every domain's entry point so each domain module's `SequelizeModule.forFeature` registers its models
 * (autoLoadModels). A spec may boot only one domain, but associations reach into others (Payment ↔ BisOrder,
 * BisOrderItem → Product, …), and Sequelize needs both sides defined. This replaces the old ALL_MODELS list
 * (debt D-9): domains own their model registration; the harness just loads them all.
 */
import '@app/domains/asset-library';
import '@app/domains/assistant';
import '@app/domains/auctions';
import '@app/domains/billing';
import '@app/domains/catalog';
import '@app/domains/catalog-sync';
import '@app/domains/chat';
import '@app/domains/community';
import '@app/domains/content';
import '@app/domains/developer-platform';
import '@app/domains/discovery';
import '@app/domains/experimentation';
import '@app/domains/fulfilment';
import '@app/domains/identity';
import '@app/domains/launch-events';
import '@app/domains/marketing';
import '@app/domains/media';
import '@app/domains/notifications';
import '@app/domains/orders';
import '@app/domains/payments';
import '@app/domains/seller-insights';
import '@app/domains/seller-onboarding';
import '@app/domains/shop-functions';
import '@app/domains/statements';
import '@app/domains/tenancy';

export interface TestingModuleOptions {
  /** Extra store modules the feature under test needs (real docker-compose test instances, D5). */
  stores?: Array<'redis' | 'cassandra' | 'dynamo' | 'sqs' | 'storage' | 'elasticsearch'>;
}

const STORE_MODULES = {
  redis: RedisModule,
  cassandra: CassandraModule,
  dynamo: DynamoModule,
  sqs: SqsModule,
  storage: StorageModule,
  elasticsearch: ElasticsearchModule,
} as const;

export const generateTestingModule = async (module: any, options: TestingModuleOptions = {}) => {
  const imports = [
    // global modules
    ConfigUtilsModule,
    ErrorUtilsModule,
    ApiConfigModule,
    SequelizeModule.forRootAsync({
      imports: [ApiConfigModule],
      inject: [ApiConfigService],
      useFactory: (configService: ApiConfigService) => {
        return {
          dialect: 'postgres',
          host: configService.get('db_host'),
          port: Number(configService.get('db_port')),
          username: configService.get('db_username'),
          password: configService.get('db_password'),
          database: configService.get('db_name'),
          autoLoadModels: true,
          synchronize: false,
          logging: false,
        };
      },
    }),
    ScheduleModule.forRoot(),

    // needed for exceptions filter and throttler
    ThrottlerModule.forRootAsync({
      imports: [ApiConfigModule],
      inject: [ApiConfigService],
      useFactory: (config: ApiConfigService) => ({
        throttlers: [
          {
            ttl: config.get('throttle_api_ttl'),
            limit: config.get('throttle_api_limit'),
          },
        ],
      }),
    }),

    // F-01 platform pieces the app modules rely on (CLS context, CLS transactions,
    // readiness/shutdown registries). Logging and load shedding are left out of tests.
    RequestContextModule,
    TransactionModule,
    HealthModule,
    TestCleanupModule,
    // Global in every app (core imports it): ShopGuard/@ShopScoped controllers need MembershipService.
    TenancyModule,
    // Always on in the test stack; Tenancy → Cache/RateLimit need it even when a spec lists no stores.
    RedisModule,

    ...(options.stores ?? []).filter((store) => store !== 'redis').map((store) => STORE_MODULES[store]),

    // test modules
    // SeedsModule,
  ];

  if (Array.isArray(module)) {
    imports.push(...module);
  } else {
    imports.push(module);
  }

  return await Test.createTestingModule({
    imports,
    providers: [
      {
        provide: APP_FILTER,
        useClass: AllExceptionsFilter,
      },
      {
        provide: APP_GUARD,
        useClass: ThrottlerGuard,
      },
    ],
  })
    .overrideProvider(ApiConfigService)
    .useFactory({
      factory: MockApiConfigServiceFactory,
      inject: [ConfigUtilsService],
    })
    .compile();
};
