import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { SearchController } from './api/search.controller';
import { SearchClickController } from './api/search-click.controller';
import { SearchIndexAdminController } from './api/search-index-admin.controller';
import { SearchClickService } from './application/search-click.service';
import { SearchQualityService } from './application/search-quality.service';
import { ShopProductSearchController } from './api/shop-product-search.controller';
import { ShopProductSearchService } from './application/shop-product-search.service';
import { CancelReindexService } from './application/reindex/cancel-reindex.service';
import { GetRunsService } from './application/reindex/get-runs.service';
import { SearchAudit } from './application/reindex/reindex-audit';
import { StartReindexService } from './application/reindex/start-reindex.service';
import { SearchIndexStatusService } from './application/search-index-status.service';
import { ProductSearchService } from './application/product-search.service';
import { SynonymsService } from './application/synonyms.service';
import { ProductTitleSuggester } from './application/title-suggester.service';
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
    ClickHouseModule,
    EventsModule.forAggregates([
      { aggregateType: 'search', retention: 'full-history' },
    ]),
    RateLimitModule.forFeature(discoveryRatePolicies),
    JobsModule,
  ],
  controllers: [
    SearchController,
    SearchClickController,
    SearchIndexAdminController,
    ShopProductSearchController,
  ],
  providers: [
    ProductSearchService,
    ShopProductSearchService,
    // exported for other domains; the autocomplete module gets its own through `SearchIndexModule`
    ProductTitleSuggester,
    SearchClickService,
    SearchQualityService,
    SearchAudit,
    StartReindexService,
    CancelReindexService,
    GetRunsService,
    SearchIndexStatusService,
    SynonymsService,
    { provide: SEARCH_EVENT_PUBLISHER, useClass: SearchEventPublisherAdapter },
  ],
  exports: [ProductSearchService, ProductTitleSuggester],
})
export class ProductSearchModule {}
