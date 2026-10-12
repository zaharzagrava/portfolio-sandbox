import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';
import { KeyRotationService } from '../../application/key-rotation.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'auth.rotate-signing-keys': Record<string, never>;
  }
}

declareJobType({
  name: 'auth.rotate-signing-keys',
  contract: z.object({}),
});

/**
 * Daily (apps/worker): the S49 schedule runs `auth.rotate-signing-keys` once across replicas (FR-062). Nothing
 * rotates at boot (VIII.6); a fresh environment gets its first key lazily on first use (`KeyStore.sign`).
 */
@Injectable()
export class KeyRotationJobs implements OnApplicationBootstrap {
  constructor(
    private readonly jobs: JobsService,
    private readonly rotation: KeyRotationService,
  ) {}

  async onApplicationBootstrap() {
    await this.jobs.upsertSchedule({
      name: 'auth.rotate-signing-keys',
      cron: '0 4 * * *',
      jobType: 'auth.rotate-signing-keys',
      payload: {},
    });
  }

  @JobHandler('auth.rotate-signing-keys', { concurrency: 1 })
  async rotate(): Promise<void> {
    await this.rotation.run();
  }
}
