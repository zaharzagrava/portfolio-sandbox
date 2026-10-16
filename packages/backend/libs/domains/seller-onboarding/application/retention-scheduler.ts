import { Inject, Injectable } from '@nestjs/common';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { EXTRACTION_CONFIG } from './extraction-config.token';
import type { ExtractionConfig } from '../domain/extraction-config';
import './onboarding-documents.job-types';

/** The scheduled deletion of a round's raw files (S04 FR-050): unique per shop and round. */
export const purgeKey = (shopId: string, submissionNo: number) =>
  `purge:${shopId}:${submissionNo}`;

/**
 * Schedules the raw-file purge of a round `rawRetentionDays` after its outcome (verification or rejection). The job is
 * unique per `(shop, round)`, so a repeated decision schedules nothing new. Must run in the deciding transaction: the job
 * row commits with the decision or not at all.
 */
@Injectable()
export class RetentionScheduler {
  constructor(
    @Inject(EXTRACTION_CONFIG) private readonly config: ExtractionConfig,
    private readonly jobs: JobsService,
  ) {}

  async schedulePurge(
    shopId: string,
    submissionNo: number,
    decidedAt: Date,
  ): Promise<void> {
    await this.jobs.enqueue(
      'onboarding.purge-documents',
      { shopId, submissionNo },
      {
        runAt: new Date(
          decidedAt.getTime() + this.config.rawRetentionDays * 86_400_000,
        ),
        idempotencyKey: purgeKey(shopId, submissionNo),
      },
    );
  }
}
