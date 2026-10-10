import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { AuthModule } from '@app/domains/identity';
import { ShopMembershipModel as ShopMembership } from '@app/domains/tenancy';
import { LiveCoreModule } from './live-core.module';
import { LiveController } from './api/live.controller';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { launchEventsRatePolicies } from './rate-limit-policies';

/** SD-15 write side (core). Delivery runs in apps/sse-gateway (LiveGatewayModule); counters in apps/worker. */
@Module({
  imports: [
    AuthModule,
    LiveCoreModule,
    RateLimitModule.forFeature(launchEventsRatePolicies),
    SequelizeModule.forFeature([ShopMembership]),
  ],
  controllers: [LiveController],
})
export class LiveModule {}
