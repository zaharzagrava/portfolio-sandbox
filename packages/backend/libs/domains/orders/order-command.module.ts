import { Module } from '@nestjs/common';
import { OrdersCoreModule } from './orders-core.module';

/**
 * The commands other capabilities send to `orders` (IX.7 R1), loadable without the HTTP routes or the job handlers:
 * the auctions worker imports this and nothing else of orders (S21 contracts/services.md). It re-exports the shared
 * core module, whose `OrderCommandService` is the only provider a caller may inject.
 */
@Module({
  imports: [OrdersCoreModule],
  exports: [OrdersCoreModule],
})
export class OrderCommandModule {}
