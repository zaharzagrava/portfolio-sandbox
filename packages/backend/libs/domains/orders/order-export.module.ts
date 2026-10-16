import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { TenancyModule } from '@app/domains/tenancy';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { OrderExportController } from './api/order-export.controller';
import { OrderExportCoreModule } from './order-export-core.module';
import { ordersRatePolicies } from './rate-limit-policies';

/** HTTP side (apps/core) of the order export: the `/shops/:shopId/order-exports` routes. */
@Module({
  imports: [
    OrderExportCoreModule,
    AuthModule,
    TenancyModule,
    IdempotencyModule,
    RateLimitModule.forFeature(ordersRatePolicies),
  ],
  controllers: [OrderExportController],
})
export class OrderExportModule {}
