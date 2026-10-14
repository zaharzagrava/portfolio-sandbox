import { Module } from '@nestjs/common';
import { FlashSaleJobs } from './infra/flash-sale.jobs';
import { FlashSaleCoreModule } from './flash-sale-core.module';
import { FlashSaleLifecycleModule } from './flash-sale-lifecycle.module';
import { OrdersCoreModule } from './orders-core.module';

/** Background side of flash sales (apps/worker): the lifecycle job handlers and their periodic schedules. */
@Module({
  imports: [OrdersCoreModule, FlashSaleCoreModule, FlashSaleLifecycleModule],
  providers: [FlashSaleJobs],
})
export class FlashSaleWorkerModule {}
