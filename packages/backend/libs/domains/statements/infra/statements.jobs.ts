import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { StatementService } from '../application/statement.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'statements.close-month': { month?: string };
  }
}

@Injectable()
export class StatementsJobs implements OnApplicationBootstrap {
  constructor(
    private readonly statements: StatementService,
    private readonly jobs: JobsService,
  ) {}

  async onApplicationBootstrap() {
    // 02:00 on the 2nd: gives late payments of the previous month a day to settle.
    await this.jobs.upsertSchedule({
      name: 'statements.close-month',
      cron: '0 2 2 * *',
      jobType: 'statements.close-month',
      payload: {},
    });
  }

  @JobHandler('statements.close-month', { concurrency: 1, leaseMs: 1_800_000 })
  async closeMonth({ month }: { month?: string }) {
    const d = new Date();
    const previous =
      month ??
      new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1))
        .toISOString()
        .slice(0, 10);
    await this.statements.closeMonth(previous);
  }

  @JobHandler('statements.retro-adjust', { concurrency: 1, leaseMs: 1_800_000 })
  async retroAdjust(payload: {
    shopKey: string;
    category: string;
    from: string;
    to: string | null;
    reason: string;
  }) {
    await this.statements.retroAdjust(payload);
  }
}
