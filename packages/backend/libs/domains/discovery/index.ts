/**
 * Public entry point of the `discovery` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/discovery`. Modules, services and event contracts only: no projector, consumer, logger or model
 * leaves this file (S32 FR-058); the apps import the three search modules.
 */
export { AutocompleteWorkerModule } from './autocomplete-worker.module';
export { AutocompleteModule } from './autocomplete.module';
export { RecommendationsProjectorModule } from './recommendations-projector.module';
export { RecommendationsWorkerModule } from './recommendations-worker.module';
export { RecommendationsModule } from './recommendations.module';
export { ProductSearchModule } from './product-search.module';
export { SearchProjectorModule } from './search-projector.module';
export { SearchWorkerModule } from './search-worker.module';
export { ProductSearchService } from './application/product-search.service';
export type { SearchCall } from './application/product-search.service';
export { ProductTitleSuggester } from './application/title-suggester.service';
export {
  SearchUnavailableError,
  SearchValidationError,
  SuggestionTimeoutError,
} from './domain/search-errors';
export { SearchPerformed } from './application/events/search-query-events';
export { SearchResultClicked } from './application/events/search-click-events';
export { SearchReindexCompleted } from './application/events/search-reindex-events';
export { discoveryRatePolicies } from './rate-limit-policies';
export { TrendingModule, TrendingProjectorModule } from './trending.module';
