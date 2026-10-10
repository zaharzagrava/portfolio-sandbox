/**
 * Public entry point of the `discovery` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/discovery`. Generated from actual cross-domain usage in Phase 2 (later batches append); extend
 * it by hand when a new export is needed. Models exported here are transitional (IX.4 debt): other
 * domains must stop injecting them.
 */
export { AutocompleteWorkerModule } from './autocomplete-worker.module';
export { AutocompleteModule } from './autocomplete.module';
export { RecommendationsWorkerModule } from './recommendations-worker.module';
export { RecommendationsModule } from './recommendations.module';
export { ProductSearchModule } from './product-search.module';
export { SearchProjectorModule } from './search-projector.module';
export { SearchWorkerModule } from './search-worker.module';
export { discoveryRatePolicies } from './rate-limit-policies';
export { SearchAdminModule } from './search-admin.module';
export { TrendingConsumerModule, TrendingModule } from './trending.module';
export { TrendingService } from './application/trending.service';
export { OrderBasketsProjector } from './infra/order-baskets.projector';
export { SearchClicksProjector } from './infra/search-clicks.projector';
export { SearchQueriesProjector } from './infra/search-queries.projector';
export { SearchQueryLogger } from './infra/search-query-logger';
export { TrendingConsumer } from './infra/trending.consumer';
