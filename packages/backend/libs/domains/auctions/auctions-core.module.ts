import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/config';
import { ProblemCatalogModule } from '@app/common/errors';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { ProductModule } from '@app/domains/catalog';
import { OrderCommandModule } from '@app/domains/orders';
import { TenancyModule } from '@app/domains/tenancy';
import {
  AUCTION_REALTIME,
  AUCTION_REPOSITORY,
  AUCTION_STOCK,
  AUCTION_VIEW_CACHE,
  BID_REPOSITORY,
  ORDER_REQUEST,
  PRODUCT_CATALOG,
  SHOP_MEMBERSHIP,
} from './domain/auction-ports';
import { AUCTION_PROBLEMS } from './domain/auction-problems';
import {
  AUCTION_CRASH_POINT,
  BID_DECISION_GATE,
  noCrash,
  noGate,
} from './application/auction-test-seams';
import { AUCTIONS_AGGREGATE } from './application/events/auction-events';
import { AuctionPublisher } from './application/auction-publisher';
import { AuctionScheduleService } from './application/auction-schedule.service';
import { BidService } from './application/bid.service';
import { AuctionQueryService } from './application/auction-query.service';
import { AuctionCloseService } from './application/auction-close.service';
import { SettlementService } from './application/settlement.service';
import { AuctionStockAdapter } from './infra/auction-stock.adapter';
import { AuctionRealtimeAdapter } from './infra/auction-realtime.adapter';
import { auctionSettingsProvider } from './infra/auction-settings.provider';
import { AuctionViewCache } from './infra/auction-view.cache';
import { SequelizeAuctionRepository } from './infra/auction.repository';
import { SequelizeBidRepository } from './infra/bid.repository';
import { BidPartitionService } from './infra/bid-partitions.service';
import AuctionHistory from './infra/models/auction-history.model';
import Auction from './infra/models/auction.model';
import Bid from './infra/models/bid.model';
import { OrderRequestAdapter } from './infra/order-request.adapter';
import { ProductCatalogAdapter } from './infra/product-catalog.adapter';
import { ShopMembershipAdapter } from './infra/shop-membership.adapter';

/**
 * Everything the HTTP side (`AuctionsModule`) and the background side (`AuctionsWorkerModule`) share: the repositories
 * and adapters bound to their ports, the settings and the application services (S21 D-6). One module, so the two sides
 * never declare the same provider twice. The test seams bind to no-ops; the test kit overrides them.
 */
@Module({
  imports: [
    ApiConfigModule,
    ClockModule,
    EventsModule.forAggregates([AUCTIONS_AGGREGATE]),
    JobsModule,
    RealtimeModule,
    ProductModule,
    TenancyModule,
    OrderCommandModule,
    ProblemCatalogModule.forFeature(AUCTION_PROBLEMS),
    SequelizeModule.forFeature([Auction, Bid, AuctionHistory]),
  ],
  providers: [
    auctionSettingsProvider,
    { provide: AUCTION_REPOSITORY, useClass: SequelizeAuctionRepository },
    { provide: BID_REPOSITORY, useClass: SequelizeBidRepository },
    { provide: PRODUCT_CATALOG, useClass: ProductCatalogAdapter },
    { provide: AUCTION_STOCK, useClass: AuctionStockAdapter },
    { provide: SHOP_MEMBERSHIP, useClass: ShopMembershipAdapter },
    { provide: ORDER_REQUEST, useClass: OrderRequestAdapter },
    { provide: AUCTION_VIEW_CACHE, useClass: AuctionViewCache },
    { provide: AUCTION_REALTIME, useClass: AuctionRealtimeAdapter },
    { provide: AUCTION_CRASH_POINT, useValue: noCrash },
    { provide: BID_DECISION_GATE, useValue: noGate },
    BidPartitionService,
    AuctionPublisher,
    AuctionScheduleService,
    BidService,
    AuctionQueryService,
    AuctionCloseService,
    SettlementService,
  ],
  exports: [
    BidService,
    AuctionQueryService,
    AuctionCloseService,
    SettlementService,
    auctionSettingsProvider,
    AUCTION_REPOSITORY,
    BID_REPOSITORY,
    AUCTION_STOCK,
    SHOP_MEMBERSHIP,
    AUCTION_VIEW_CACHE,
    BidPartitionService,
    AuctionPublisher,
    AuctionScheduleService,
    SequelizeModule,
  ],
})
export class AuctionsCoreModule {}
