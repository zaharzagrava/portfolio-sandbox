import { INestApplication, Module } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ProductModule } from '@app/domains/catalog';
import { OrderCommandModule } from '@app/domains/orders';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { jsonBodyLimits } from '@app/infrastructure/platform/body-limits';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { ApiKeyGuard } from './api/api-key.guard';
import { BatchController } from './api/batch.controller';
import { BulkStockController } from './api/bulk-stock.controller';
import { ContentGuard } from './api/content.guard';
import { LifecycleGuard } from './api/lifecycle.guard';
import { PublicOpenApiController } from './api/openapi.controller';
import { DtoOperationValidator } from './api/operation-validator';
import { PublicApiInterceptor } from './api/public-api.interceptor';
import { RequestContextMiddleware } from './api/request-context.middleware';
import { ScopeGuard } from './api/scope.guard';
import { V1Controller } from './api/v1.controller';
import { VersionGuard } from './api/version.guard';
import { BatchService } from './application/batch.service';
import { BulkStockService } from './application/bulk-stock.service';
import { QuotaGate } from './application/quota.gate';
import { QuotaGuard } from './api/quota.guard';
import { BillingQuotaAdapter } from './infra/billing-quota.adapter';
import { KafkaRequestRecordPublisher } from './infra/kafka-request-record.publisher';
import { RequestRecordSink } from './infra/request-record.sink';
import { RedisQuotaCache } from './infra/redis-quota-cache';
import { PublicCatalogService } from './application/public-catalog.service';
import { PublicOrdersService } from './application/public-orders.service';
import { DeveloperPlatformCoreModule } from './developer-platform-core.module';
import {
  OperationValidator,
  QuotaCache,
  QuotaPort,
  RequestRecordPublisher,
} from './domain/ports';
import { developerPlatformRatePolicies } from './rate-limit-policies';

// A body may be up to 2 MiB on every public route (FR-060): a bulk file of 10,000 items is about 1 MB, a batch with big bodies more.
jsonBodyLimits.register({ match: /^\/v1\//, limit: '2mb' });

/**
 * The public API surface (apps/public-api): the `/v1` routes and everything they need, each imported explicitly so the
 * deployable boots alone (L-018). Request identifiers, no-store and the deprecation registry are the middleware's, on
 * every route, before authentication.
 */
@Module({
  imports: [
    DeveloperPlatformCoreModule,
    ProductModule,
    OrderCommandModule,
    KafkaProducerModule,
    CacheModule,
    SqsModule,
    IdempotencyModule,
    RateLimitModule.forFeature(developerPlatformRatePolicies),
  ],
  providers: [
    ApiKeyGuard,
    LifecycleGuard,
    VersionGuard,
    ContentGuard,
    ScopeGuard,
    QuotaGuard,
    QuotaGate,
    { provide: QuotaPort, useClass: BillingQuotaAdapter },
    { provide: QuotaCache, useClass: RedisQuotaCache },
    { provide: RequestRecordPublisher, useClass: KafkaRequestRecordPublisher },
    RequestRecordSink,
    RequestContextMiddleware,
    PublicApiInterceptor,
    { provide: OperationValidator, useClass: DtoOperationValidator },
    PublicCatalogService,
    PublicOrdersService,
    BulkStockService,
    BatchService,
  ],
  controllers: [
    V1Controller,
    BulkStockController,
    BatchController,
    PublicOpenApiController,
  ],
})
export class PublicApiModule {}

/**
 * The request context as a handler for `configureHttpApp({ beforeBodyParsing })`: it must run in front of the body
 * parsers, so that a request the parser refuses (over 2 MiB, JSON that does not parse) still has its `Request-Id` and
 * leaves its record.
 */
export function publicApiRequestContext(app: INestApplication) {
  return (req: Request, res: Response, next: NextFunction): void => {
    app.get(RequestContextMiddleware, { strict: false }).use(req, res, next);
  };
}
