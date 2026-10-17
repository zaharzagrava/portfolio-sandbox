import { Module } from '@nestjs/common';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { ProductQueryModule } from '@app/domains/catalog';
import { TenancyModule } from '@app/domains/tenancy';
import { CompetitorEvaluationService } from './application/competitor-evaluation.service';
import { SELLER_INSIGHTS_AGGREGATE } from './application/events/seller-insights-events';
import { CompetitorStoresModule } from './competitor-stores.module';

/**
 * Per-watch evaluation of an observation (S41 FR-025 to FR-028). It needs products and owners (R1) and the outbox,
 * and runs in the core process (a new watch is evaluated when it is registered) and in the worker (after a crawl).
 */
@Module({
  imports: [
    CompetitorStoresModule,
    ProductQueryModule,
    TenancyModule,
    EventsModule.forAggregates([SELLER_INSIGHTS_AGGREGATE]),
  ],
  providers: [CompetitorEvaluationService],
  exports: [CompetitorEvaluationService],
})
export class CompetitorEvaluationModule {}
