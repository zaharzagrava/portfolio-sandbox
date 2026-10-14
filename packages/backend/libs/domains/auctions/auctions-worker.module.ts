import { Module } from '@nestjs/common';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { AuctionsCoreModule } from './auctions-core.module';
import { AuctionSettlementConsumer } from './infra/auction-settlement.consumer';
import { AuctionJobs } from './infra/auction.jobs';

/**
 * The job handlers (S21 contracts/services.md). It imports only the orders command module for the winner's order; no
 * order model, no `OrderService`, no `ORDER_MODELS` (FR-039). The e2e specs load this module alone and call the
 * handlers directly, so no Kafka consumer starts in a spec.
 */
@Module({
  imports: [AuctionsCoreModule],
  providers: [AuctionJobs],
  exports: [AuctionJobs],
})
export class AuctionsJobsModule {}

/** Background side (apps/worker): the job handlers and the consumer of `orders.events`. */
@Module({
  imports: [
    AuctionsJobsModule,
    ProjectionsModule.forProjectors(
      [AuctionSettlementConsumer],
      [AuctionsCoreModule],
    ),
  ],
})
export class AuctionsWorkerModule {}
