import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { SearchController } from './api/search.controller';
import { SearchIndexAdminController } from './api/search-index-admin.controller';
import { CancelReindexService } from './application/reindex/cancel-reindex.service';
import { GetRunsService } from './application/reindex/get-runs.service';
import { SearchAudit } from './application/reindex/reindex-audit';
import { StartReindexService } from './application/reindex/start-reindex.service';
import { SearchIndexStatusService } from './application/search-index-status.service';
import { ProductSearchService } from './application/product-search.service';
import { SEARCH_EVENT_PUBLISHER } from './domain/ports';
import { SearchEventPublisherAdapter } from './infra/search-event.publisher';
import { discoveryRatePolicies } from './rate-limit-policies';
import { SearchIndexModule } from './search-index.module';

/**
 * The search HTTP side (apps/core): the public search route and the exported in-process service. Imported before the
 * catalog's module so `/products/search` is matched before `/products/:id`.
 */
@Module({
  imports: [
    SearchIndexModule,
    AuthModule,
    EventsModule.forAggregates([
      { aggregateType: 'search', retention: 'full-history' },
    ]),
    RateLimitModule.forFeature(discoveryRatePolicies),
    JobsModule,
  ],
  controllers: [SearchController, SearchIndexAdminController],
  providers: [
    ProductSearchService,
    SearchAudit,
    StartReindexService,
    CancelReindexService,
    GetRunsService,
    SearchIndexStatusService,
    { provide: SEARCH_EVENT_PUBLISHER, useClass: SearchEventPublisherAdapter },
  ],
  exports: [ProductSearchService],
})
export class ProductSearchModule {}
