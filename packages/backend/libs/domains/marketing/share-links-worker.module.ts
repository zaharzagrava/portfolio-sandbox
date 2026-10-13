import { Module } from '@nestjs/common';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { FilterRebuildService } from './application/filter-rebuild.service';
import { ShareLinksJobs } from './infra/share-links.jobs';
import { ShareLinksStoresModule } from './share-links-stores.module';

/**
 * Background side of share links (apps/worker, S37 G9): the existence filter rebuild, scheduled through the jobs
 * toolkit (S49). Shares the stores module with the HTTP side; it provides no second copy of any adapter.
 */
@Module({
  imports: [ShareLinksStoresModule, JobsModule],
  providers: [FilterRebuildService, ShareLinksJobs],
  exports: [FilterRebuildService],
})
export class ShareLinksWorkerModule {}
