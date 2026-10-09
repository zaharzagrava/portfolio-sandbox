import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { DomainEventsService } from '@app/infrastructure/events/domain-events.service';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { Answers, requiredDocuments } from '../domain/questionnaire';
import { ShopVerified } from './events/onboarding-events';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'onboarding.purge-documents': { shopId: string };
  }
}

/** Raw KYC files are kept this long after verification (disputes, audits), then deleted; extracted fields stay sealed. */
export const RAW_DOCUMENT_RETENTION_DAYS = 30;

@Injectable()
export class VerificationService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly events: DomainEventsService,
    private readonly jobs: JobsService,
  ) {}

  /**
   * Called after any document becomes APPROVED (automatically or by a
   * reviewer). Serialized per shop by locking its onboarding row, so two
   * documents approved at the same moment can't both miss - or both fire -
   * the verification.
   */
  async maybeVerify(shopId: string): Promise<boolean> {
    // S54 T037 audit: explicit unit of work, opens its own transaction by design; no network I/O inside.
    return this.sequelize.transaction(async (transaction) => {
      const [onboarding] = await this.sequelize.query<{ answers: Answers }>(
        `SELECT answers FROM "ShopOnboarding" WHERE "shopId" = :shopId FOR UPDATE`,
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

      const [shop] = await this.sequelize.query<{ id: string }>(
        `UPDATE "Shop" SET "verificationStatus" = 'VERIFIED', "payoutsEnabled" = TRUE, "updatedAt" = now() WHERE id = :shopId AND "verificationStatus" <> 'VERIFIED' RETURNING id`,
        { type: QueryTypes.SELECT, transaction, replacements: { shopId } },
      );
      if (!shop) return false;
      const verifiedAt = new Date();
      await this.sequelize.query(
        `UPDATE "ShopOnboarding" SET "verifiedAt" = :verifiedAt WHERE "shopId" = :shopId`,
        { transaction, replacements: { shopId, verifiedAt } },
      );
      await this.events.record(
        ShopVerified.create(shopId, 2, {
          shopId,
          verifiedAt: verifiedAt.toISOString(),
        }),
        transaction,
      );
      await this.jobs.enqueue(
        'onboarding.purge-documents',
        { shopId },
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
