import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ProductModule } from '@app/domains/catalog';
import { AuthModule } from '@app/domains/identity';
import { TenancyModule } from '@app/domains/tenancy';
import { FlashSaleController } from './infra/flash/flash-sale.controller';
import { FlashSaleJobs } from './infra/flash/flash-sale.jobs';
import FlashSale from './infra/flash/flash-sale.model';
import { FlashStockService } from './infra/flash/flash-stock.service';
import { OrdersCoreModule } from './orders-core.module';

/**
 * Legacy flash sales, parked here until S11 replaces them (S10 research D-9): not part of the S10 contract and not on
 * the checkout path. Stock moves only through the catalog's `applyStockDelta`. HTTP side: the scheduling route.
 */
@Module({
  imports: [
    OrdersCoreModule,
    AuthModule,
    ProductModule,
    TenancyModule,
    SequelizeModule.forFeature([FlashSale]),
  ],
  providers: [FlashStockService],
  controllers: [FlashSaleController],
  exports: [FlashStockService],
})
export class FlashSaleLegacyModule {}

/** Background side: the start, end and reconcile jobs of a drop. */
@Module({
  imports: [
    OrdersCoreModule,
    ProductModule,
    SequelizeModule.forFeature([FlashSale]),
  ],
  providers: [FlashStockService, FlashSaleJobs],
})
export class FlashSaleLegacyJobsModule {}
