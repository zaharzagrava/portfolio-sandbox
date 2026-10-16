import { Module } from '@nestjs/common';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { TenancyModule } from '@app/domains/tenancy';
import { OrderExportTopics } from './api/order-export-topics';

/** Registers the live topic `order-export:<id>` in the SSE gateway (imported there). */
@Module({
  imports: [RealtimeModule, TenancyModule],
  providers: [OrderExportTopics],
})
export class OrderExportTopicsModule {}
