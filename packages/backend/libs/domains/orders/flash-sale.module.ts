import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { ProductModule } from '@app/domains/catalog';
import { TenancyModule } from '@app/domains/tenancy';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { FlashSaleService } from './application/flash-sale.service';
import { FlashPublicService } from './application/flash-public.service';
import { FlashSaleController } from './api/flash-sale.controller';
import { FlashSalePublicController } from './api/flash-sale-public.controller';
import { FlashSaleCoreModule } from './flash-sale-core.module';
import { FlashSaleLifecycleModule } from './flash-sale-lifecycle.module';
import { OrdersCoreModule } from './orders-core.module';

/**
 * HTTP side of flash sales (apps/core): the seller's routes. The ports and the reservation seam live in
 * `FlashSaleCoreModule`; nothing here is exported past the domain (the barrel names no flash type).
 */
@Module({
  imports: [
    OrdersCoreModule,
    FlashSaleCoreModule,
    FlashSaleLifecycleModule,
    AuthModule,
    ProductModule,
    TenancyModule,
    JobsModule,
  ],
  providers: [FlashSaleService, FlashPublicService],
  controllers: [FlashSaleController, FlashSalePublicController],
})
export class FlashSaleModule {}
