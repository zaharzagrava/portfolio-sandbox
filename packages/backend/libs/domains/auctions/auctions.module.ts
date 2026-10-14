import { Module } from '@nestjs/common';
import { ErrorUtilsModule } from '@app/common/errors/error-utils/error-utils.module';
import { BillingModule } from '@app/domains/billing';
import { AuthModule } from '@app/domains/identity';
import { TenancyModule } from '@app/domains/tenancy';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { AuctionsCoreModule } from './auctions-core.module';
import { AuctionBidController } from './api/auction-bid.controller';
import { AuctionPublicController } from './api/auction-public.controller';
import { AuctionSellerController } from './api/auction-seller.controller';
import { auctionsRatePolicies } from './rate-limit-policies';

/** HTTP side (apps/core): the seller, bidder and public routes. Shares its providers with the worker side. */
@Module({
  imports: [
    AuctionsCoreModule,
    ErrorUtilsModule, // for `AuctionExceptionFilter`, which delegates to the platform filter
    AuthModule,
    BillingModule,
    TenancyModule,
    IdempotencyModule,
    RateLimitModule.forFeature(auctionsRatePolicies),
  ],
  controllers: [
    AuctionSellerController,
    AuctionBidController,
    AuctionPublicController,
  ],
})
export class AuctionsModule {}
