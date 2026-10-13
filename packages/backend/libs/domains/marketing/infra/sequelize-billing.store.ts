import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import type {
  AdjustmentRecord,
  BillingRunRecord,
  BillingStore,
  NewAdjustment,
  NewBillingRun,
  ReconciliationRunRecord,
  StatementQuery,
  StatementRow,
} from '../domain/ads-ports';

type RunRow = Omit<
  BillingRunRecord,
  'amountMinor' | 'clicks' | 'billableClicks' | 'cappedClicks'
> & {
  amountMinor: string | number;
  clicks: number;
  billableClicks: number;
  cappedClicks: number;
};
type AdjustmentRow = Omit<AdjustmentRecord, 'deltaMinor'> & {
  deltaMinor: string | number;
};

const RUN_COLUMNS = `r."campaignId", r."hour", r."state", r."source", r."clicks", r."billableClicks", r."cappedClicks",
  r."amountMinor", r."ledgerReference", r."journalId", r."chargedAt", r."createdAt"`;
const ADJUSTMENT_COLUMNS = `a."campaignId", a."hour", a."sequence", a."deltaClicks", a."deltaMinor", a."ledgerReference",
  a."state", a."journalId", a."postedAt"`;

const toRun = (row: RunRow): BillingRunRecord => ({
  ...row,
  amountMinor: Number(row.amountMinor),
});
const toAdjustment = (row: AdjustmentRow): AdjustmentRecord => ({
  ...row,
  deltaMinor: Number(row.deltaMinor),
});

/**
 * `AdBillingRun`, `AdBillingAdjustment` and `AdReconciliationRun` behind the `BillingStore` port. A run is frozen at
 * insert and only moves `PENDING → CHARGED`; an adjustment only `PENDING → POSTED`; a closed day is never rewritten
 * because corrections are new, dated rows (FR-053). Every write is a conditional statement (III.6).
 */
@Injectable()
export class SequelizeBillingStore implements BillingStore {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private select<T extends object>(
    sql: string,
    replacements: Record<string, unknown>,
  ): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      type: QueryTypes.SELECT,
      replacements,
    });
  }

  async insertRun(run: NewBillingRun, now: Date): Promise<boolean> {
    const rows = await this.select(
      `INSERT INTO "AdBillingRun" ("campaignId", "hour", "state", "source", "clicks", "billableClicks", "cappedClicks",
                                    "amountMinor", "ledgerReference", "chargedAt", "createdAt")
       VALUES (:campaignId, :hour, :state, :source, :clicks, :billableClicks, :cappedClicks, :amountMinor,
               :ledgerReference, CASE WHEN :state = 'CHARGED' THEN CAST(:now AS TIMESTAMPTZ) END, :now)
       ON CONFLICT DO NOTHING
       RETURNING "campaignId"`,
      { ...run, now },
    );
    return rows.length > 0;
  }

  async findRun(
    campaignId: string,
    hour: Date,
  ): Promise<BillingRunRecord | null> {
    const [row] = await this.select<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM "AdBillingRun" r WHERE r."campaignId" = :campaignId AND r."hour" = :hour`,
      { campaignId, hour },
    );
    return row ? toRun(row) : null;
  }

  async markCharged(
    campaignId: string,
    hour: Date,
    journalId: string | null,
    now: Date,
  ): Promise<boolean> {
    const rows = await this.select(
      `UPDATE "AdBillingRun" SET "state" = 'CHARGED', "journalId" = :journalId, "chargedAt" = :now
        WHERE "campaignId" = :campaignId AND "hour" = :hour AND "state" = 'PENDING'
        RETURNING "campaignId"`,
      { campaignId, hour, journalId, now },
    );
    return rows.length > 0;
  }

  async netBilledBefore(
    campaignId: string,
    dayStart: Date,
    hourExclusive: Date,
  ): Promise<number> {
    const [row] = await this.select<{ net: string }>(
      `SELECT COALESCE((SELECT SUM(r."amountMinor") FROM "AdBillingRun" r
                         WHERE r."campaignId" = :campaignId AND r."hour" >= :dayStart AND r."hour" < :hourExclusive), 0)
            + COALESCE((SELECT SUM(a."deltaMinor") FROM "AdBillingAdjustment" a
                         WHERE a."campaignId" = :campaignId AND a."hour" >= :dayStart AND a."hour" < :hourExclusive
                           AND a."state" = 'POSTED'), 0) AS "net"`,
      { campaignId, dayStart, hourExclusive },
    );
    return Number(row.net);
  }

  async netChargedInDay(campaignId: string, dayStart: Date): Promise<number> {
    const [row] = await this.select<{ net: string }>(
      `SELECT COALESCE((SELECT SUM(r."amountMinor") FROM "AdBillingRun" r
                         WHERE r."campaignId" = :campaignId AND r."hour" >= :dayStart
                           AND r."hour" < CAST(:dayStart AS TIMESTAMPTZ) + interval '1 day' AND r."state" = 'CHARGED'), 0)
            + COALESCE((SELECT SUM(a."deltaMinor") FROM "AdBillingAdjustment" a
                         WHERE a."campaignId" = :campaignId AND a."hour" >= :dayStart
                           AND a."hour" < CAST(:dayStart AS TIMESTAMPTZ) + interval '1 day' AND a."state" = 'POSTED'), 0) AS "net"`,
      { campaignId, dayStart },
    );
    return Number(row.net);
  }

  async runsOfDay(
    campaignId: string,
    dayStart: Date,
  ): Promise<BillingRunRecord[]> {
    const rows = await this.select<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM "AdBillingRun" r
        WHERE r."campaignId" = :campaignId AND r."hour" >= :dayStart
          AND r."hour" < CAST(:dayStart AS TIMESTAMPTZ) + interval '1 day'
        ORDER BY r."hour"`,
      { campaignId, dayStart },
    );
    return rows.map(toRun);
  }

  async adjustmentsOf(
    campaignId: string,
    hour: Date,
  ): Promise<AdjustmentRecord[]> {
    const rows = await this.select<AdjustmentRow>(
      `SELECT ${ADJUSTMENT_COLUMNS} FROM "AdBillingAdjustment" a
        WHERE a."campaignId" = :campaignId AND a."hour" = :hour ORDER BY a."sequence"`,
      { campaignId, hour },
    );
    return rows.map(toAdjustment);
  }

  async insertAdjustment(
    adjustment: NewAdjustment,
    now: Date,
  ): Promise<boolean> {
    const rows = await this.select(
      `INSERT INTO "AdBillingAdjustment" ("campaignId", "hour", "sequence", "deltaClicks", "deltaMinor", "ledgerReference",
                                           "state", "reconciliationRunId", "createdAt")
       VALUES (:campaignId, :hour, :sequence, :deltaClicks, :deltaMinor, :ledgerReference, 'PENDING',
               :reconciliationRunId, :now)
       ON CONFLICT DO NOTHING
       RETURNING "campaignId"`,
      { ...adjustment, now },
    );
    return rows.length > 0;
  }

  async markAdjustmentPosted(
    campaignId: string,
    hour: Date,
    sequence: number,
    journalId: string,
    now: Date,
  ): Promise<boolean> {
    const rows = await this.select(
      `UPDATE "AdBillingAdjustment" SET "state" = 'POSTED', "journalId" = :journalId, "postedAt" = :now
        WHERE "campaignId" = :campaignId AND "hour" = :hour AND "sequence" = :sequence AND "state" = 'PENDING'
        RETURNING "campaignId"`,
      { campaignId, hour, sequence, journalId, now },
    );
    return rows.length > 0;
  }

  async campaignIdsWithRuns(dayStart: Date): Promise<string[]> {
    const rows = await this.select<{ campaignId: string }>(
      `SELECT DISTINCT r."campaignId" FROM "AdBillingRun" r
        WHERE r."hour" >= :dayStart AND r."hour" < CAST(:dayStart AS TIMESTAMPTZ) + interval '1 day'`,
      { dayStart },
    );
    return rows.map((r) => r.campaignId);
  }

  async statement(
    campaignId: string,
    query: StatementQuery,
  ): Promise<StatementRow[]> {
    const runs = (
      await this.select<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM "AdBillingRun" r
          WHERE r."campaignId" = :campaignId AND r."hour" >= :from AND r."hour" < :to
            AND (CAST(:before AS TIMESTAMPTZ) IS NULL OR r."hour" < CAST(:before AS TIMESTAMPTZ))
          ORDER BY r."hour" DESC LIMIT :limit`,
        {
          campaignId,
          from: query.from,
          to: query.to,
          before: query.before ?? null,
          limit: query.limit,
        },
      )
    ).map(toRun);
    if (runs.length === 0) return [];
    const adjustments = (
      await this.select<AdjustmentRow>(
        `SELECT ${ADJUSTMENT_COLUMNS} FROM "AdBillingAdjustment" a
          WHERE a."campaignId" = :campaignId AND a."hour" IN (:hours) ORDER BY a."hour", a."sequence"`,
        { campaignId, hours: runs.map((r) => r.hour) },
      )
    ).map(toAdjustment);
    return runs.map((run) => ({
      run,
      adjustments: adjustments.filter(
        (a) => a.hour.getTime() === run.hour.getTime(),
      ),
    }));
  }

  async startReconciliation(
    day: string,
    now: Date,
  ): Promise<ReconciliationRunRecord | null> {
    const [row] = await this.select<ReconciliationRunRecord>(
      `INSERT INTO "AdReconciliationRun" ("day", "status", "startedAt") VALUES (:day, 'RUNNING', :now)
       ON CONFLICT ("day") WHERE "status" = 'RUNNING' DO NOTHING
       RETURNING "id", to_char("day", 'YYYY-MM-DD') AS "day", "status", "reason", "hoursChecked", "hoursAdjusted",
                 "netDeltaMinor", "driftRatio"`,
      { day, now },
    );
    return row ?? null;
  }

  async abandonStaleReconciliations(
    day: string,
    olderThan: Date,
  ): Promise<number> {
    const rows = await this.select(
      `UPDATE "AdReconciliationRun" SET "status" = 'FAILED', "reason" = 'abandoned', "finishedAt" = :olderThan
        WHERE "day" = :day AND "status" = 'RUNNING' AND "startedAt" < :olderThan
        RETURNING "id"`,
      { day, olderThan },
    );
    return rows.length;
  }

  async finishReconciliation(
    id: string,
    patch: Parameters<BillingStore['finishReconciliation']>[1],
    now: Date,
  ): Promise<void> {
    await this.sequelize.query(
      `UPDATE "AdReconciliationRun" SET
              "status" = COALESCE(:status, "status"), "reason" = :reason,
              "hoursChecked" = COALESCE(:hoursChecked, "hoursChecked"),
              "hoursAdjusted" = COALESCE(:hoursAdjusted, "hoursAdjusted"),
              "netDeltaMinor" = COALESCE(:netDeltaMinor, "netDeltaMinor"),
              "driftRatio" = :driftRatio, "finishedAt" = :now
        WHERE "id" = :id`,
      {
        replacements: {
          id,
          now,
          status: patch.status ?? null,
          reason: patch.reason ?? null,
          hoursChecked: patch.hoursChecked ?? null,
          hoursAdjusted: patch.hoursAdjusted ?? null,
          netDeltaMinor: patch.netDeltaMinor ?? null,
          driftRatio: patch.driftRatio ?? null,
        },
      },
    );
  }
}
