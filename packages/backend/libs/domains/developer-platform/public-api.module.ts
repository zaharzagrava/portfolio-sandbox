import { Module } from '@nestjs/common';
import { ProductModule, PRODUCTS_AGGREGATE } from '@app/domains/catalog';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { ApiKeysService } from './application/api-keys.service';
import { ApiKeyGuard } from './api/api-key.guard';
import { PublicApiInterceptor } from './api/public-api.interceptor';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { PublicCatalogService } from './application/public-catalog.service';
import { PublicOrdersService } from './application/public-orders.service';
import { V1Controller } from './api/v1.controller';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { developerPlatformRatePolicies } from './rate-limit-policies';

/** SD-07 public API surface (apps/public-api). */
@Module({
  imports: [
    ProductModule,
    EventsModule.forAggregates([PRODUCTS_AGGREGATE]),
    KafkaProducerModule,
    CacheModule,
    SqsModule,
    IdempotencyModule,
    RateLimitModule.forFeature(developerPlatformRatePolicies),
  ],
  providers: [
    ApiKeysService,
    ApiKeyGuard,
    PublicApiInterceptor,
    PublicCatalogService,
    PublicOrdersService,
  ],
  exports: [ApiKeysService, PublicCatalogService],
  controllers: [V1Controller],
})
export class PublicApiModule {}
