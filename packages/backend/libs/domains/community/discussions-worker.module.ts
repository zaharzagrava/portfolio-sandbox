import { Module } from '@nestjs/common';
import { CassandraModule } from '@app/infrastructure/cassandra/cassandra.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { VoteService } from './application/vote.service';
import { DiscussionsJobs } from './infra/discussions.jobs';

/** SD-11 background side (apps/worker): vote counter flush, exact recounts. */
@Module({
  imports: [CassandraModule, JobsModule],
  providers: [VoteService, DiscussionsJobs],
})
export class DiscussionsWorkerModule {}
