/**
 * Public entry point of the `catalog` domain (constitution X.4). Code outside this domain imports only from
 * `@app/domains/catalog`: modules, the exported R1 services, their DTO types, error classes and event contracts.
 */
export { ProductBatchReadModule } from './batch-read.module';
export { ProductModule } from './product.module';
export { ProductProjectorModule } from './product-projector.module';
export { ProductWorkerModule } from './product-worker.module';
export { catalogRatePolicies } from './rate-limit-policies';

export { ProductCommandService } from './application/product-command.service';
export { ProductQueryService } from './application/product-query.service';
export { ProductStockService } from './application/product-stock.service';
export type {
  ApplyStockResult,
  StockFailureCode,
} from './application/product-stock.service';
export { ProductImportService } from './application/product-import.service';
export type {
  ExternalSource,
  ExternalUpsertResult,
} from './application/product-import.service';
export type { StockOperation } from './domain/stock-input';
export type { ProductDto } from './domain/product-view';
export {
  CurrencyNotSupportedError,
  InvalidTransitionError,
  ProductArchivedError,
  ProductNotFoundError,
  ShopNotActiveError,
  StockOperationConflictError,
  VersionConflictError,
} from './domain/product-errors';
export {
  ProductArchived,
  ProductCreated,
  ProductDeleted,
  ProductRestored,
  ProductUpdated,
} from './application/events/product-events';

// TRANSITIONAL (specs/domains/S05-products/plan.md, Complexity Tracking): the exports below stay only while the
// capabilities listed in gaps.md section C still import them. Do not add to this block; delete a line when its last
// importer has converted (`product-boundary.e2e-spec.ts` pins the list so it can only shrink).
export { default as ProductModel } from './infra/models/product.model';
export { CollabModule } from './collab.module';
export { DraftsModule } from './drafts.module';
export { ProductDtoModule } from './product-dto.module';
export { ProductDtoService } from './infra/product-dto.service';
export { ProductService } from './application/product.service';
export {
  ProductChanged,
  productChanged,
  PRODUCTS_AGGREGATE,
} from './application/events/product-events';
