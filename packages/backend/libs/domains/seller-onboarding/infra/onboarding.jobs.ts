import { Injectable } from '@nestjs/common';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { RetentionService } from '../application/retention.service';
import '../application/onboarding-documents.job-types';

/**
 * The retention jobs (S04 FR-050, A28). `onboarding.purge-documents` deletes the raw files of one round 30 days after
 * its verification or rejection - sealed fields stay; `onboarding.erase-records` hard-deletes a deleted shop's records
 * after the record period. Both are single-run (their unique keys) and idempotent; the work is the retention service's.
 */
@Injectable()
export class OnboardingJobs {
  constructor(private readonly retention: RetentionService) {}

  @JobHandler('onboarding.purge-documents')
  async purge({
    shopId,
    submissionNo,
  }: {
    shopId: string;
    submissionNo: number;
  }) {
    await this.retention.purgeRound(shopId, submissionNo);
  }

  @JobHandler('onboarding.erase-records')
  async erase({ shopId, dueAt }: { shopId: string; dueAt?: string }) {
    await this.retention.erase(shopId, dueAt);
  }
}
