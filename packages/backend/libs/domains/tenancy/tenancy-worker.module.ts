import { Module } from '@nestjs/common';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { TENANCY_AGGREGATE } from './domain/events';
import { SHOP_REPOSITORY } from './domain/ports';
import { SequelizeShopRepository } from './infra/models/shop.repository';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { MemberRevocationConsumer } from './infra/member-revocation.consumer';
import { ShopPlanConsumer } from './infra/shop-plan.consumer';
import { TenancyBackfillJobs } from './infra/tenancy-backfill.jobs';

/** What the plan consumer injects: the shop repository and the outbox (the transaction runner comes from the global TenancyModule). */
@Module({
  imports: [EventsModule.forAggregates([TENANCY_AGGREGATE])],
  providers: [{ provide: SHOP_REPOSITORY, useClass: SequelizeShopRepository }],
  exports: [SHOP_REPOSITORY, EventsModule],
})
export class TenancyPlanStateModule {}

/**
 * Background side of tenancy, hosted by apps/worker: the backfill job (enqueue once:
 * `jobs.enqueue('tenancy.backfill-shops', {})`) and the consumer of `billing.subscription_plan_changed` (AS-73) and the consumer of `tenancy.member_removed` that ends the removed
 * member's open realtime streams (S51 follow-up from S03).
 */
@Module({
  imports: [
    ProjectionsModule.forProjectors(
      [ShopPlanConsumer, MemberRevocationConsumer],
      [TenancyPlanStateModule, RealtimeModule],
    ),
  ],
  providers: [TenancyBackfillJobs],
})
export class TenancyWorkerModule {}
