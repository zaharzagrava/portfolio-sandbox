import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import Auction from './infra/models/auction.model';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { RealtimeModule } from '@app/infrastructure/realtime/realtime.module';
import {
  FlashStockService,
  OrderService,
  ORDER_MODELS,
} from '@app/domains/orders';
import { AuctionJobs } from './infra/auction.jobs';
import { BidRelay } from './infra/bid-relay.service';

/** SD-22 background side (apps/worker): bid relay (Redis stream → Postgres), close, second chance. */
@Module({
  imports: [
    EventsModule.forAggregates([
      { aggregateType: 'auctions', retention: 'full-history' },
    ]),
    RealtimeModule,
    SequelizeModule.forFeature([Auction, ...ORDER_MODELS]),
  ],
  providers: [AuctionJobs, BidRelay, OrderService, FlashStockService],
})
export class AuctionsWorkerModule {}
