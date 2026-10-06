import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { VoteService } from '../application/vote.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'discussions.flush-votes': Record<string, never>;
    'discussions.recount': { targetId: string };
  }
}

@Injectable()
export class DiscussionsJobs implements OnApplicationBootstrap {
  constructor(
    private readonly votes: VoteService,
    private readonly jobs: JobsService,
  ) {}

  async onApplicationBootstrap() {
    await this.jobs.upsertSchedule({ name: 'discussions.flush-votes', cron: '*/5 * * * * *', jobType: 'discussions.flush-votes', payload: {} });
  }

  @JobHandler('discussions.flush-votes', { concurrency: 1 })
  async flush() {
    await this.votes.flushToCounters();
  }

  @JobHandler('discussions.recount', { concurrency: 4 })
  async recount({ targetId }: { targetId: string }) {
    await this.votes.recount(targetId);
  }
}
