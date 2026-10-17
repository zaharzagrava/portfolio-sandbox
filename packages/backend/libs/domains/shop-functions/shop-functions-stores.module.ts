import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { OutboxModule } from '@app/infrastructure/outbox/outbox.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { ShopFunctionsConfig } from './application/shop-functions.config';
import {
  ACTIVE_SET_CACHE,
  BREAKER_STORE,
  FUNCTION_REPOSITORY,
  FUNCTION_RUNNER,
  JUDGE_REQUESTS,
  MEMO_CACHE,
  TEST_CASE_REPOSITORY,
  VERSION_REPOSITORY,
} from './domain/ports';
import ShopFunction from './infra/models/shop-function.model';
import ShopFunctionTestCase from './infra/models/shop-function-test-case.model';
import ShopFunctionVersion from './infra/models/shop-function-version.model';
import ShopFunctionVersionHistory from './infra/models/shop-function-version-history.model';
import { OutboxJudgeRequests } from './infra/outbox-judge-requests';
import { PgFunctionRepository } from './infra/pg-function.repository';
import { PgTestCaseRepository } from './infra/pg-test-case.repository';
import { PgVersionRepository } from './infra/pg-version.repository';
import { RedisActiveSetCache } from './infra/redis-active-set.cache';
import { RedisBreakerStore } from './infra/redis-breaker.store';
import { RedisMemoCache } from './infra/redis-memo.cache';
import {
  DEFAULT_RUNNER_SOCKET,
  RUNNER_SOCKET_PATH,
  RunnerClient,
} from './infra/runner.client';

/**
 * The stores of the seller discount functions bound to their ports (L-018): Postgres repositories, the Redis caches and
 * breaker, the outbox hand-off and the runner client. Imported by the core and worker modules so each app boots on
 * its own. Internal to the domain: the barrel does not export it.
 */
@Module({
  imports: [
    SequelizeModule.forFeature([
      ShopFunction,
      ShopFunctionVersion,
      ShopFunctionTestCase,
      ShopFunctionVersionHistory,
    ]),
    ClockModule,
    OutboxModule,
  ],
  providers: [
    {
      provide: ShopFunctionsConfig,
      useFactory: () => ShopFunctionsConfig.fromEnv(),
    },
    {
      provide: RUNNER_SOCKET_PATH,
      useFactory: () =>
        process.env.FUNCTION_RUNNER_SOCKET ?? DEFAULT_RUNNER_SOCKET,
    },
    PgFunctionRepository,
    PgVersionRepository,
    PgTestCaseRepository,
    RedisActiveSetCache,
    RedisMemoCache,
    RedisBreakerStore,
    OutboxJudgeRequests,
    RunnerClient,
    { provide: FUNCTION_REPOSITORY, useExisting: PgFunctionRepository },
    { provide: VERSION_REPOSITORY, useExisting: PgVersionRepository },
    { provide: TEST_CASE_REPOSITORY, useExisting: PgTestCaseRepository },
    { provide: ACTIVE_SET_CACHE, useExisting: RedisActiveSetCache },
    { provide: MEMO_CACHE, useExisting: RedisMemoCache },
    { provide: BREAKER_STORE, useExisting: RedisBreakerStore },
    { provide: JUDGE_REQUESTS, useExisting: OutboxJudgeRequests },
    { provide: FUNCTION_RUNNER, useExisting: RunnerClient },
  ],
  exports: [
    ShopFunctionsConfig,
    RUNNER_SOCKET_PATH,
    FUNCTION_REPOSITORY,
    VERSION_REPOSITORY,
    TEST_CASE_REPOSITORY,
    ACTIVE_SET_CACHE,
    MEMO_CACHE,
    BREAKER_STORE,
    JUDGE_REQUESTS,
    FUNCTION_RUNNER,
  ],
})
export class ShopFunctionsStoresModule {}
