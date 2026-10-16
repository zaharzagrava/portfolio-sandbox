import { Injectable, Logger } from '@nestjs/common';

export interface ReviewAuditRecord {
  event: 'review.resolve' | 'review.file_link';
  reviewerId: string;
  taskId: string;
  shopId: string | null;
  /** `APPROVE`, `REJECT`, `REJECT_APPLICATION`, or `LINK`. */
  decision: string;
  /** `accepted`, or the stable error code of the refusal. */
  outcome: string;
}

/**
 * Audit lines for the reviewers' actions (S04 FR-035, AS-48): who did what to which task and how it ended - ids and
 * stable codes only. No extracted value, IBAN, link or free-text reason ever reaches this logger.
 */
@Injectable()
export class OnboardingAudit {
  private readonly logger = new Logger('Audit');

  record(entry: ReviewAuditRecord): void {
    this.logger.log(JSON.stringify({ audit: 'seller-onboarding', ...entry }));
  }
}
