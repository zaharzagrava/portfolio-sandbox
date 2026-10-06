import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';

/**
 * Retention (05/02 §9): raw KYC files are deleted RAW_DOCUMENT_RETENTION_DAYS
 * after verification; the sealed extracted fields remain (needed for payouts
 * and audits). Idempotent: purged rows are skipped, deleting a missing object
 * is a no-op.
 */
@Injectable()
export class OnboardingJobs {
  private readonly logger = new Logger(OnboardingJobs.name);

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly storage: ObjectStorage,
  ) {}

  @JobHandler('onboarding.purge-documents')
  async purge({ shopId }: { shopId: string }) {
    const docs = await this.sequelize.query<{ id: string; storageKey: string }>(
      `SELECT id, "storageKey" FROM "ShopDocument" WHERE "shopId" = :shopId AND "purgedAt" IS NULL AND status IN ('APPROVED', 'REJECTED', 'SUPERSEDED')`,
      { type: QueryTypes.SELECT, replacements: { shopId } },
    );
    for (const doc of docs) {
      await this.storage.delete(doc.storageKey);
      await this.sequelize.query(`UPDATE "ShopDocument" SET "purgedAt" = now() WHERE id = :id`, { replacements: { id: doc.id } });
    }
    this.logger.log(`purged ${docs.length} KYC files of shop ${shopId}`);
  }
}
