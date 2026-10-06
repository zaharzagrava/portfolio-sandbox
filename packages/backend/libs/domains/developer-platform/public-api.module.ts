import { Module } from '@nestjs/common';
import { ProductModule } from '@app/domains/catalog';
import { OutboxModule } from '@app/infrastructure/outbox/outbox.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { ApiKeysService } from './application/api-keys.service';
import { ApiKeyGuard } from './api/api-key.guard';
import { PublicApiInterceptor } from './api/public-api.interceptor';
import { IdempotencyInterceptor } from '@app/infrastructure/idempotency/idempotency.interceptor';
import { PublicCatalogService } from './application/public-catalog.service';
import { PublicOrdersService } from './application/public-orders.service';
import { V1Controller } from './api/v1.controller';

/** SD-07 public API surface (apps/public-api). */
@Module({
  imports: [ProductModule, OutboxModule, KafkaProducerModule, CacheModule, SqsModule],
  providers: [ApiKeysService, ApiKeyGuard, PublicApiInterceptor, IdempotencyInterceptor, PublicCatalogService, PublicOrdersService],
  exports: [ApiKeysService, PublicCatalogService],
  controllers: [V1Controller],
})
export class PublicApiModule {}
