import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/config';
import { ElasticsearchModule } from '@app/infrastructure/elasticsearch/elasticsearch.module';
import {
  INDEX_MANAGER,
  PROJECTION_LAG,
  REINDEX_PROBE,
  EMBEDDING_PROVIDER,
  PRODUCT_IMAGE_RESOLVER,
  PRODUCT_INDEX,
  REINDEX_RUN_REPOSITORY,
  SHOP_SEARCH_REPOSITORY,
  SHOP_STATE_REPOSITORY,
  SYNONYM_SET_REPOSITORY,
} from './domain/ports';
import { HashEmbeddingProvider } from './infra/embedding/hash-embedding.provider';
import { NullImageResolver } from './infra/image/null-image.resolver';
import { SearchIndexManager } from './infra/index-manager.adapter';
import { KafkaProjectionLag } from './infra/projection-lag.adapter';
import { IndexBootstrapService } from './infra/index-bootstrap.service';
import SearchReindexRun from './infra/models/search-reindex-run.model';
import SearchReindexRunHistory from './infra/models/search-reindex-run-history.model';
import SearchShopProduct from './infra/models/search-shop-product.model';
import SearchShopState from './infra/models/search-shop-state.model';
import SearchSynonymSet from './infra/models/search-synonym-set.model';
import SearchSynonymVersion from './infra/models/search-synonym-version.model';
import { ProductIndexAdapter } from './infra/product-index.adapter';
import { SequelizeReindexRunRepository } from './infra/repositories/reindex-run.repository';
import { SequelizeShopSearchRepository } from './infra/repositories/shop-search.repository';
import { SequelizeShopStateRepository } from './infra/repositories/shop-state.repository';
import { SequelizeSynonymSetRepository } from './infra/repositories/synonym-set.repository';
import { SearchIndexRegistry } from './infra/search-index-registry';
import { SearchSettings } from './infra/search-settings';

/**
 * The search domain's stores and ports, shared by the core, projector and worker modules (it is not exported from the
 * entry point): the engine adapter, the six discovery-owned tables, the embedding provider and the image resolver.
 * Providers are bound to injection tokens; a spec or a later capability swaps an adapter by overriding the token.
 */
@Module({
  imports: [
    ApiConfigModule,
    ElasticsearchModule,
    SequelizeModule.forFeature([
      SearchShopProduct,
      SearchShopState,
      SearchReindexRun,
      SearchReindexRunHistory,
      SearchSynonymSet,
      SearchSynonymVersion,
    ]),
  ],
  providers: [
    SearchSettings,
    IndexBootstrapService,
    SearchIndexRegistry,
    { provide: PRODUCT_INDEX, useClass: ProductIndexAdapter },
    { provide: SHOP_STATE_REPOSITORY, useClass: SequelizeShopStateRepository },
    {
      provide: SHOP_SEARCH_REPOSITORY,
      useClass: SequelizeShopSearchRepository,
    },
    {
      provide: REINDEX_RUN_REPOSITORY,
      useClass: SequelizeReindexRunRepository,
    },
    {
      provide: SYNONYM_SET_REPOSITORY,
      useClass: SequelizeSynonymSetRepository,
    },
    { provide: INDEX_MANAGER, useClass: SearchIndexManager },
    { provide: PROJECTION_LAG, useClass: KafkaProjectionLag },
    // no pause points in production; a spec binds its own probe
    { provide: REINDEX_PROBE, useValue: {} },
    { provide: EMBEDDING_PROVIDER, useClass: HashEmbeddingProvider },
    { provide: PRODUCT_IMAGE_RESOLVER, useClass: NullImageResolver },
  ],
  exports: [
    SearchSettings,
    IndexBootstrapService,
    SearchIndexRegistry,
    PRODUCT_INDEX,
    SHOP_STATE_REPOSITORY,
    SHOP_SEARCH_REPOSITORY,
    REINDEX_RUN_REPOSITORY,
    SYNONYM_SET_REPOSITORY,
    INDEX_MANAGER,
    PROJECTION_LAG,
    REINDEX_PROBE,
    EMBEDDING_PROVIDER,
    PRODUCT_IMAGE_RESOLVER,
    ElasticsearchModule,
  ],
})
export class SearchIndexModule {}
