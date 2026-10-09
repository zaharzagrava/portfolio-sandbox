import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'tenancy.backfill-shops': { batchSize?: number };
  }
}

/**
 * Expand/contract backfill (lesson 03/03 §1): turns every legacy seller (User
 * with products) into a Shop they OWN, then stamps shopId on their products
 * and chat channels - in small batches (short transactions, no long locks,
 * replication-lag friendly), re-enqueueing itself until nothing is left.
 * When the backfill is done it runs the CONTRACT step itself
 * (CHECK ... NOT VALID → VALIDATE), so migrations never block on data.
 */
@Injectable()
export class TenancyBackfillJobs {
  private readonly logger = new Logger(TenancyBackfillJobs.name);

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly jobs: JobsService,
  ) {}

  @JobHandler('tenancy.backfill-shops', { concurrency: 1, leaseMs: 300_000 })
  async backfill({ batchSize = 200 }: { batchSize?: number }): Promise<void> {
    const sellers = await this.sequelize.query<{ sellerId: string }>(
      `SELECT DISTINCT "sellerId" FROM "Product" WHERE "shopId" IS NULL AND "sellerId" IS NOT NULL LIMIT :batchSize`,
      { type: QueryTypes.SELECT, replacements: { batchSize } },
    );

    for (const { sellerId } of sellers) {
      // S54 T037 audit: explicit unit of work, opens its own transaction by design; no network I/O inside.
      await this.sequelize.transaction(async (transaction) => {
        // Idempotent: a re-run after a crash finds the existing shop via the slug.
        const [[shop]] = (await this.sequelize.query(
          `WITH s AS (
             INSERT INTO "Shop" (name, slug) VALUES (:name, :slug)
             ON CONFLICT (slug) DO UPDATE SET "updatedAt" = now()
             RETURNING id
           ),
           m AS (INSERT INTO "ShopMembership" ("shopId", "userId", role) SELECT id, :sellerId, 'OWNER' FROM s ON CONFLICT DO NOTHING),
           d AS (INSERT INTO "ShopDirectory" ("shopId") SELECT id FROM s ON CONFLICT DO NOTHING)
           SELECT id FROM s`,
          {
            replacements: {
              sellerId,
              name: `Shop ${sellerId.slice(0, 8)}`,
              slug: `seller-${sellerId}`,
            },
            transaction,
          },
        )) as [[{ id: string }], unknown];

        await this.sequelize.query(
          `UPDATE "Product" SET "shopId" = :shopId WHERE "sellerId" = :sellerId AND "shopId" IS NULL`,
          {
            replacements: { shopId: shop.id, sellerId },
            transaction,
          },
        );
        await this.sequelize.query(
          `UPDATE "ChatChannel" SET "shopId" = :shopId WHERE "sellerId" = :sellerId AND "shopId" IS NULL`,
          {
            replacements: { shopId: shop.id, sellerId },
            transaction,
          },
        );
      });
    }

    if (sellers.length === batchSize) {
      await this.jobs.enqueue(
        'tenancy.backfill-shops',
        { batchSize },
        { runAt: new Date(Date.now() + 1_000) },
      );
      return;
    }

    await this.contract();
  }

  private async contract(): Promise<void> {
    const [{ exists }] = await this.sequelize.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Product_shopId_not_null') AS exists`,
      { type: QueryTypes.SELECT },
    );
    if (!exists) {
      await this.sequelize.query(`SET lock_timeout = '5s'`);
      await this.sequelize.query(
        `ALTER TABLE "Product" ADD CONSTRAINT "Product_shopId_not_null" CHECK ("shopId" IS NOT NULL OR "sellerId" IS NULL) NOT VALID`,
      );
    }
    // VALIDATE scans with SHARE UPDATE EXCLUSIVE: reads and writes keep flowing.
    await this.sequelize.query(
      `ALTER TABLE "Product" VALIDATE CONSTRAINT "Product_shopId_not_null"`,
    );
    this.logger.log(
      'tenancy backfill complete; Product.shopId contract constraint validated',
    );
  }
}
