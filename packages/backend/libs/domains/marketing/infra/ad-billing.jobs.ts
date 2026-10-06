import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { v7 as uuidv7 } from 'uuid';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { LedgerService, LEDGER_ACCOUNTS, shopAccount } from '@app/domains/payments';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'ads.bill-hour': { hour?: string };
    'ads.reconcile-day': { day?: string };
  }
}

const chHour = (d: Date) => d.toISOString().slice(0, 13).replace('T', ' ') + ':00:00';

/**
 * Charges shops for valid clicks (SD-20 ledger):
 *  - hourly, from the streaming aggregates (fast, exactly-once upstream);
 *  - daily, a reconciliation recomputes every billed hour from the raw,
 *    click_id-deduplicated log and posts an ADJUSTMENT for any difference
 *    (lambda architecture: the batch path is the source of truth).
 * Each (campaign, hour) is charged once - `AdBillingRun` primary key in the
 * same transaction as the journal. Charges are capped by the daily budget.
 */
@Injectable()
export class AdBillingJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdBillingJobs.name);

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly clickhouse: ClickHouseService,
    private readonly ledger: LedgerService,
    private readonly jobs: JobsService,
  ) {}

  async onApplicationBootstrap() {
    await this.jobs.upsertSchedule({ name: 'ads.bill-hour', cron: '5 * * * *', jobType: 'ads.bill-hour', payload: {} });
    await this.jobs.upsertSchedule({ name: 'ads.reconcile-day', cron: '30 2 * * *', jobType: 'ads.reconcile-day', payload: {} });
  }

  @JobHandler('ads.bill-hour', { concurrency: 1 })
  async billHour({ hour }: { hour?: string } = {}): Promise<{ campaigns: number; amountCents: number }> {
    const start = hour ? new Date(hour) : new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000);
    const rows = await this.clickhouse.query<{ campaign_id: string; clicks: string }>(
      `SELECT campaign_id, sum(clicks) AS clicks FROM ad_click_minute FINAL
       WHERE minute >= {from:DateTime} AND minute < {from:DateTime} + INTERVAL 1 HOUR GROUP BY campaign_id HAVING clicks > 0`,
      { from: chHour(start) },
    );
    let total = 0;
    for (const { campaign_id, clicks } of rows) total += await this.charge(campaign_id, start, Number(clicks));
    return { campaigns: rows.length, amountCents: total };
  }

  @JobHandler('ads.reconcile-day', { concurrency: 1 })
  async reconcileDay({ day }: { day?: string } = {}): Promise<number> {
    const from = day ? new Date(`${day}T00:00:00Z`) : new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 - 86_400_000);
    const exact = await this.clickhouse.query<{ campaign_id: string; hour: string; clicks: string }>(
      `SELECT campaign_id, toString(toStartOfHour(ts)) AS hour, countIf(valid = 1) AS clicks FROM ad_clicks_raw FINAL
       WHERE ts >= {from:DateTime} AND ts < {from:DateTime} + INTERVAL 1 DAY GROUP BY campaign_id, hour`,
      { from: chHour(from) },
    );
    let adjusted = 0;
    for (const row of exact) {
      const hour = new Date(`${row.hour.replace(' ', 'T')}Z`);
      const [run] = await this.sequelize.query<{ clicks: number; reconciledClicks: number | null }>(`SELECT clicks, "reconciledClicks" FROM "AdBillingRun" WHERE "campaignId" = :c AND hour = :hour`, {
        type: QueryTypes.SELECT,
        replacements: { c: row.campaign_id, hour },
      });
      if (!run) {
        await this.charge(row.campaign_id, hour, Number(row.clicks)); // the stream path missed the hour entirely
        adjusted++;
      } else if (run.reconciledClicks === null && run.clicks !== Number(row.clicks)) {
        await this.adjust(row.campaign_id, hour, run.clicks, Number(row.clicks));
        adjusted++;
      }
    }
    return adjusted;
  }

  private async charge(campaignId: string, hour: Date, clicks: number): Promise<number> {
    return this.sequelize.transaction(async (transaction) => {
      const [c] = await this.sequelize.query<{ shopId: string; cpcCents: number; dailyBudgetCents: number; spentToday: string }>(
        `SELECT c."shopId", c."cpcCents", c."dailyBudgetCents",
                coalesce((SELECT sum("amountCents") FROM "AdBillingRun" r WHERE r."campaignId" = c.id AND r.hour >= date_trunc('day', CAST(:hour AS timestamptz)) AND r.hour < date_trunc('day', CAST(:hour AS timestamptz)) + interval '1 day'), 0) AS "spentToday"
         FROM "AdCampaign" c WHERE c.id = :campaignId FOR UPDATE`,
        { type: QueryTypes.SELECT, replacements: { campaignId, hour }, transaction },
      );
      if (!c) return 0;
      const amount = Math.max(0, Math.min(clicks * c.cpcCents, c.dailyBudgetCents - Number(c.spentToday)));
      const journalId = uuidv7();
      const [inserted] = await this.sequelize.query(
        `INSERT INTO "AdBillingRun" ("campaignId", hour, clicks, "amountCents", "journalId") VALUES (:campaignId, :hour, :clicks, :amount, :journalId)
         ON CONFLICT DO NOTHING RETURNING "journalId"`,
        { type: QueryTypes.SELECT, replacements: { campaignId, hour, clicks, amount, journalId }, transaction },
      );
      if (!inserted || amount === 0) return 0;
      await this.ledger.post({ journalId, kind: 'AD_CHARGE', lines: [{ accountId: shopAccount(c.shopId), amount: -amount }, { accountId: LEDGER_ACCOUNTS.PLATFORM_FEES, amount }] }, transaction);
      return amount;
    });
  }

  private async adjust(campaignId: string, hour: Date, billedClicks: number, exactClicks: number) {
    await this.sequelize.transaction(async (transaction) => {
      const [c] = await this.sequelize.query<{ shopId: string; cpcCents: number }>(`SELECT "shopId", "cpcCents" FROM "AdCampaign" WHERE id = :campaignId`, {
        type: QueryTypes.SELECT,
        replacements: { campaignId },
        transaction,
      });
      const delta = (exactClicks - billedClicks) * c.cpcCents; // > 0: under-billed, < 0: refund the shop
      const journalId = uuidv7();
      const [updated] = await this.sequelize.query(
        `UPDATE "AdBillingRun" SET "reconciledClicks" = :exactClicks, "adjustmentJournalId" = :journalId WHERE "campaignId" = :campaignId AND hour = :hour AND "reconciledClicks" IS NULL RETURNING 1`,
        { type: QueryTypes.SELECT, replacements: { exactClicks, journalId, campaignId, hour }, transaction },
      );
      if (!updated || delta === 0) return;
      await this.ledger.post({ journalId, kind: 'ADJUSTMENT', lines: [{ accountId: shopAccount(c.shopId), amount: -delta }, { accountId: LEDGER_ACCOUNTS.PLATFORM_FEES, amount: delta }] }, transaction);
      this.logger.log(`ad billing reconciled ${campaignId} ${hour.toISOString()}: ${billedClicks} → ${exactClicks}`);
    });
  }
}
