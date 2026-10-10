import * as path from 'path';

import { SequelizeModule } from '@nestjs/sequelize';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { ApiConfigModule, ApiConfigService } from '@app/common/config';

import { ScheduleModule } from '@nestjs/schedule';
import { MockApiConfigServiceFactory } from '@app/common/config/api-config.service.mock';
import { ConfigUtilsService } from '@app/common/config/config-utils/config-utils.service';

import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from '@app/common/exceptions-filter';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { ConfigUtilsModule } from '@app/common/config/config-utils/config-utils.module';
import { ErrorUtilsModule } from '@app/common/errors/error-utils/error-utils.module';
import {
  RequestContextModule,
  TransactionModule,
} from '@app/infrastructure/context';

import { HealthModule } from '@app/infrastructure/health';
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
import { assistantRatePolicies } from '@app/domains/assistant';
import { auctionsRatePolicies } from '@app/domains/auctions';
import '@app/domains/billing';
import { catalogRatePolicies } from '@app/domains/catalog';
import { catalogSyncRatePolicies } from '@app/domains/catalog-sync';
import '@app/domains/chat';
import { communityRatePolicies } from '@app/domains/community';
import '@app/domains/content';
import { developerPlatformRatePolicies } from '@app/domains/developer-platform';
import { discoveryRatePolicies } from '@app/domains/discovery';
import '@app/domains/experimentation';
import '@app/domains/fulfilment';
import { identityRatePolicies } from '@app/domains/identity';
import { launchEventsRatePolicies } from '@app/domains/launch-events';
import '@app/domains/marketing';
import '@app/domains/media';
import { notificationsRatePolicies } from '@app/domains/notifications';
import { ordersRatePolicies } from '@app/domains/orders';
import { paymentsRatePolicies } from '@app/domains/payments';
import '@app/domains/seller-insights';
import '@app/domains/seller-onboarding';
import '@app/domains/shop-functions';
import { statementsRatePolicies } from '@app/domains/statements';
import '@app/domains/tenancy';

const ALL_RATE_LIMIT_TABLES = [
  identityRatePolicies,
  catalogRatePolicies,
  ordersRatePolicies,
  paymentsRatePolicies,
  developerPlatformRatePolicies,
  catalogSyncRatePolicies,
  statementsRatePolicies,
  auctionsRatePolicies,
  communityRatePolicies,
  notificationsRatePolicies,
  launchEventsRatePolicies,
  assistantRatePolicies,
  discoveryRatePolicies,
];

export interface TestingModuleOptions {
  /** Extra store modules the feature under test needs (real docker-compose test instances, D5). */
  stores?: Array<
    'redis' | 'cassandra' | 'dynamo' | 'sqs' | 'storage' | 'elasticsearch'
  >;
  /** Swap providers before compile, e.g. `b => b.overrideProvider(CLOCK).useValue(fakeClock)`. */
  customize?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

const STORE_MODULES = {
  redis: RedisModule,
  cassandra: CassandraModule,
  dynamo: DynamoModule,
  sqs: SqsModule,
  storage: StorageModule,
  elasticsearch: ElasticsearchModule,
} as const;

export const generateTestingModule = async (
  module: any,
  options: TestingModuleOptions = {},
) => {
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

    // The one limiter, as in the apps, but without the default.read / default.write floor: specs of other
    // capabilities fire many requests from one address. Explicit @RateLimit policies are enforced as in production,
    // and every domain's policy table is registered because routes reference each other's names (S50 G-35).
    RateLimitModule.forRoot({ applyDefault: false }),
    ...ALL_RATE_LIMIT_TABLES.map((table) => RateLimitModule.forFeature(table)),

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

    ...(options.stores ?? [])
      .filter((store) => store !== 'redis')
      .map((store) => STORE_MODULES[store]),

    // test modules
    // SeedsModule,
  ];

  if (Array.isArray(module)) {
    imports.push(...module);
  } else {
    imports.push(module);
  }

  const builder = Test.createTestingModule({
    imports,
    providers: [
      {
        provide: APP_FILTER,
        useClass: AllExceptionsFilter,
      },
    ],
  })
    .overrideProvider(ApiConfigService)
    .useFactory({
      factory: MockApiConfigServiceFactory,
      inject: [ConfigUtilsService],
    });
  return await (options.customize?.(builder) ?? builder).compile();
};
