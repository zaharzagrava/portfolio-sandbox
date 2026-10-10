import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { AutocompleteBuildService } from './application/autocomplete-build.service';
import {
  AUTOCOMPLETE_CLOCK,
  QUERY_INDEX_SNAPSHOT_STORE,
  SEARCH_LOG_READER,
  SNAPSHOT_POINTER,
} from './domain/autocomplete-ports';
import { AutocompleteBuilderJobs } from './infra/autocomplete-builder.jobs';
import { AutocompleteSettings } from './infra/autocomplete-config';
import { SearchLogReaderAdapter } from './infra/search-log-reader.adapter';
import { SnapshotPointerAdapter } from './infra/snapshot-pointer.adapter';
import { SnapshotStoreAdapter } from './infra/snapshot-store.adapter';
import { SystemAutocompleteClock } from './infra/system-clock';

/** SD-12 offline builder (apps/worker). */
@Module({
  imports: [
    ApiConfigModule,
    ClickHouseModule,
    ClockModule,
    StorageModule,
    JobsModule,
  ],
  providers: [
    AutocompleteSettings,
    AutocompleteBuildService,
    AutocompleteBuilderJobs,
    { provide: AUTOCOMPLETE_CLOCK, useClass: SystemAutocompleteClock },
    { provide: SNAPSHOT_POINTER, useClass: SnapshotPointerAdapter },
    { provide: QUERY_INDEX_SNAPSHOT_STORE, useClass: SnapshotStoreAdapter },
    { provide: SEARCH_LOG_READER, useClass: SearchLogReaderAdapter },
  ],
})
export class AutocompleteWorkerModule {}
