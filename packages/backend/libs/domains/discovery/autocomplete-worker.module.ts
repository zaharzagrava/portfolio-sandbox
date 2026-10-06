import { Module } from '@nestjs/common';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { AutocompleteBuilderJobs } from './infra/autocomplete-builder.jobs';

/** SD-12 offline builder (apps/worker). */
@Module({
  imports: [ClickHouseModule, StorageModule, JobsModule],
  providers: [AutocompleteBuilderJobs],
})
export class AutocompleteWorkerModule {}
