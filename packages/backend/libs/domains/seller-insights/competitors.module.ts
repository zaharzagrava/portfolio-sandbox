import { Module } from '@nestjs/common';
import { ProblemCatalogModule } from '@app/common/errors/problem-catalog.module';
import { BillingModule } from '@app/domains/billing';
import { ProductQueryModule } from '@app/domains/catalog';
import { AuthModule } from '@app/domains/identity';
import { TenancyModule } from '@app/domains/tenancy';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { sellerInsightsRatePolicies } from './api/rate-limit-policies';
import { CompetitorsController } from './api/competitors.controller';
import { CompetitorWatchService } from './application/competitor-watch.service';
import { COMPETITOR_PROBLEMS } from './domain/competitor-errors';
import { CompetitorEvaluationModule } from './competitor-evaluation.module';
import { CompetitorStoresModule } from './competitor-stores.module';

/** S41 competitor routes (apps/core): register, list, remove a watch and read its price history. */
@Module({
  imports: [
    AuthModule,
    TenancyModule,
    BillingModule,
    ProductQueryModule,
    CompetitorStoresModule,
    CompetitorEvaluationModule,
    RateLimitModule.forFeature(sellerInsightsRatePolicies),
    ProblemCatalogModule.forFeature(COMPETITOR_PROBLEMS),
  ],
  providers: [CompetitorWatchService],
  controllers: [CompetitorsController],
})
export class CompetitorsModule {}
