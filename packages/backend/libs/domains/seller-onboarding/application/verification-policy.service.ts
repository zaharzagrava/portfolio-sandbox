import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { assertActiveTransaction } from '@app/infrastructure/context/transaction-scope';
import { requiredDocuments } from '../domain/questionnaire';
import {
  APPLICATIONS,
  DOCUMENTS,
  STATUS_HISTORY,
  type ApplicationRepository,
  type DocumentRepository,
  type StatusHistoryRepository,
} from '../domain/ports';
import { outcomeVersion, ShopVerified } from './events/onboarding-events';
import { RetentionScheduler } from './retention-scheduler';

/**
 * The one place that decides whether a shop is verified (S04 FR-040, A2, A4). It runs INSIDE the transaction that
 * approved the last document, under the application row lock, so two approvals racing for the last two kinds serialize:
 * exactly one of them sees every required kind approved and verifies. The verification, its history row, the
 * `shop.verified` event and the purge job commit with the approval - or none of them does (AS-53). The shop's own
 * verification status is changed by tenancy from the event; this service writes no shop table (FR-041).
 */
@Injectable()
export class VerificationPolicyService {
  constructor(
    @Inject(APPLICATIONS) private readonly applications: ApplicationRepository,
    @Inject(DOCUMENTS) private readonly documents: DocumentRepository,
    @Inject(STATUS_HISTORY) private readonly history: StatusHistoryRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly events: OutboxService,
    private readonly retention: RetentionScheduler,
  ) {}

  /** `true` when this call verified the shop. Must run inside a transaction scope. */
  async evaluate(shopId: string): Promise<boolean> {
    const tx = assertActiveTransaction();
    const application = await this.applications.lock(shopId);
    if (!application || application.status !== 'SUBMITTED') return false;

    const approved = new Set(
      await this.documents.approvedKinds(shopId, application.submissionNo),
    );
    if (!requiredDocuments(application.answers).every((k) => approved.has(k)))
      return false;

    const now = this.clock.now();
    if (!(await this.applications.verify(shopId, now))) return false;
    await this.history.append({
      entity: 'APPLICATION',
      entityId: shopId,
      shopId,
      fromStatus: 'SUBMITTED',
      toStatus: 'VERIFIED',
      actor: 'system',
      at: now,
    });
    await this.events.append(
      ShopVerified.create(shopId, outcomeVersion(application.submissionNo), {
        shopId,
        submissionNo: application.submissionNo,
        verifiedAt: now.toISOString(),
      }),
      tx,
    );
    await this.retention.schedulePurge(shopId, application.submissionNo, now);
    return true;
  }
}
