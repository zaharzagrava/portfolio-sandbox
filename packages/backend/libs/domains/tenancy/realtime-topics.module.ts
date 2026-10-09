import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { RealtimeModule } from '@app/infrastructure/realtime/realtime.module';
import ShopMembership from './infra/models/shop-membership.model';
import { ShopTopics } from './api/realtime-topics';

/** Registers `shop:{id}:live` in the SSE gateway (imported there; debt D-3). */
@Module({
  imports: [RealtimeModule, SequelizeModule.forFeature([ShopMembership])],
  providers: [ShopTopics],
})
export class ShopTopicsModule {}
