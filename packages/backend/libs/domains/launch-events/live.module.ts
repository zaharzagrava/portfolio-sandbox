import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { AuthModule } from '@app/domains/identity';
import { ShopMembershipModel as ShopMembership } from '@app/domains/tenancy';
import { LiveCoreModule } from './live-core.module';
import { LiveController } from './api/live.controller';

/** SD-15 write side (core). Delivery runs in apps/sse-gateway (LiveGatewayModule); counters in apps/worker. */
@Module({
  imports: [AuthModule, LiveCoreModule, SequelizeModule.forFeature([ShopMembership])],
  controllers: [LiveController],
})
export class LiveModule {}
