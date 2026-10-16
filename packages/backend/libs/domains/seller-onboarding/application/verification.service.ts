import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { Answers, requiredDocuments } from '../domain/questionnaire';
import { ShopVerified } from './events/onboarding-events';

import './onboarding-documents.job-types';

/** Raw KYC files are kept this long after verification (disputes, audits), then deleted; extracted fields stay sealed. */
export const RAW_DOCUMENT_RETENTION_DAYS = 30;

@Injectable()
export class VerificationService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly transactions: TransactionRunner,
    private readonly events: OutboxService,
    private readonly jobs: JobsService,
  ) {}

  /**
   * Called after any document becomes APPROVED (automatically or by a
   * reviewer). Serialized per shop by locking its onboarding row, so two
   * documents approved at the same moment can't both miss - or both fire -
   * the verification.
   */
  async maybeVerify(shopId: string): Promise<boolean> {
    return this.transactions.run(async (transaction) => {
      const [onboarding] = await this.sequelize.query<{
        answers: Answers;
        submissionNo: number;
        verifiedAt: Date | null;
      }>(
        `SELECT answers, "submissionNo", "verifiedAt" FROM "ShopOnboarding" WHERE "shopId" = :shopId FOR UPDATE`,
        {
          type: QueryTypes.SELECT,
          transaction,
          replacements: { shopId },
        },
      );
      if (!onboarding) return false;
      const approved = await this.sequelize.query<{ kind: string }>(
        `SELECT DISTINCT kind FROM "ShopDocument" WHERE "shopId" = :shopId AND status = 'APPROVED'`,
        {
          type: QueryTypes.SELECT,
          transaction,
          replacements: { shopId },
        },
      );
      const have = new Set(approved.map((r) => r.kind));
      if (!requiredDocuments(onboarding.answers).every((k) => have.has(k)))
        return false;

      // Already verified: this domain's own record says so. The shop's status and payouts flag follow `shop.verified`
      // in tenancy (S03 AS-72).
      if (onboarding.verifiedAt) return false;
      const verifiedAt = new Date();
      await this.sequelize.query(
        `UPDATE "ShopOnboarding" SET "verifiedAt" = :verifiedAt WHERE "shopId" = :shopId`,
        { transaction, replacements: { shopId, verifiedAt } },
      );
      await this.events.append(
        ShopVerified.create(shopId, 2, {
          shopId,
          submissionNo: onboarding.submissionNo,
          verifiedAt: verifiedAt.toISOString(),
        }),
        transaction,
      );
      await this.jobs.enqueue(
        'onboarding.purge-documents',
        { shopId, submissionNo: onboarding.submissionNo },
        {
          runAt: new Date(
            verifiedAt.getTime() + RAW_DOCUMENT_RETENTION_DAYS * 86_400_000,
          ),
          idempotencyKey: `onboarding-purge:${shopId}`,
        },
      );
      return true;
    });
  }
}
