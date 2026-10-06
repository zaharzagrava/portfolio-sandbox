import { BillingModule } from '@app/domains/billing';
import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import Auction from './infra/models/auction.model';
import { AuthModule } from '@app/domains/identity';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { RealtimeModule } from '@app/infrastructure/realtime/realtime.module';
import { AuctionService } from './application/auction.service';
import { AuctionsController } from './api/auctions.controller';

/** SD-22 HTTP side (core). Needs global Redis, Tenancy (membership) modules. */
@Module({
  imports: [AuthModule, BillingModule, JobsModule, RealtimeModule, SequelizeModule.forFeature([Auction])],
  providers: [AuctionService],
  exports: [AuctionService],
  controllers: [AuctionsController],
})
export class AuctionsModule {}
