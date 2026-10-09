/**
 * Public entry point of the `catalog` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/catalog`. Generated from actual cross-domain usage in Phase 2; extend it by
 * hand when a new export is needed. Models exported here are transitional (IX.4 debt): other
 * domains must stop injecting them.
 */
export { default as ProductModel } from './infra/models/product.model';
export { CollabModule } from './collab.module';
export { DraftsModule } from './drafts.module';
export { ProductDtoModule } from './product-dto.module';
export { ProductWorkerModule } from './product-worker.module';
export { ProductModule } from './product.module';
export { ProductService } from './application/product.service';
export { ProductCacheInvalidator } from './infra/product-cache-invalidator.projector';
export { ProductDtoService } from './infra/product-dto.service';
export { ProductSearchProjector } from './infra/product-search.projector';
export { ProductBatchReadModule } from './batch-read.module';
export {
  ProductChanged,
  productChanged,
  PRODUCTS_AGGREGATE,
} from './application/events/product-events';
