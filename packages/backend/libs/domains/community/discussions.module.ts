import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { CassandraModule } from '@app/infrastructure/cassandra/cassandra.module';
import { DiscussionService } from './application/discussion.service';
import { VoteService } from './application/vote.service';
import { DiscussionsController } from './api/discussions.controller';

/** SD-11 (core). Needs global Redis; Scylla via CassandraModule. */
@Module({
  imports: [AuthModule, CassandraModule],
  providers: [DiscussionService, VoteService],
  exports: [DiscussionService, VoteService],
  controllers: [DiscussionsController],
})
export class DiscussionsModule {}
