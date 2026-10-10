import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { ApiConfigModule } from '@app/common/config';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { SuggestController } from './api/suggest.controller';
import { QueryIndexService } from './application/query-index.service';
import { SuggestService } from './application/suggest.service';
import {
  AUTOCOMPLETE_CLOCK,
  CATALOG_TITLE_SOURCE,
  QUERY_INDEX_SNAPSHOT_STORE,
  SNAPSHOT_POINTER,
} from './domain/autocomplete-ports';
import { AutocompleteSettings } from './infra/autocomplete-config';
import { CatalogTitleSourceAdapter } from './infra/catalog-title-source.adapter';
import { SnapshotPointerAdapter } from './infra/snapshot-pointer.adapter';
import { SnapshotStoreAdapter } from './infra/snapshot-store.adapter';
import { SystemAutocompleteClock } from './infra/system-clock';
import { discoveryRatePolicies } from './rate-limit-policies';
import { SearchIndexModule } from './search-index.module';

/**
 * SD-12 serving side (core): `GET /suggest`, the query index that follows the snapshot pointer and the catalog source. It
 * exports nothing and is not global (S33 FR-041): the query logger and projectors belong to search.
 */
@Module({
  imports: [
    AuthModule,
    ApiConfigModule,
    ClockModule,
    StorageModule,
    SearchIndexModule,
    RateLimitModule.forFeature(discoveryRatePolicies),
  ],
  controllers: [SuggestController],
  providers: [
    AutocompleteSettings,
    SuggestService,
    QueryIndexService,
    { provide: AUTOCOMPLETE_CLOCK, useClass: SystemAutocompleteClock },
    { provide: SNAPSHOT_POINTER, useClass: SnapshotPointerAdapter },
    { provide: QUERY_INDEX_SNAPSHOT_STORE, useClass: SnapshotStoreAdapter },
    { provide: CATALOG_TITLE_SOURCE, useClass: CatalogTitleSourceAdapter },
  ],
})
export class AutocompleteModule {}
