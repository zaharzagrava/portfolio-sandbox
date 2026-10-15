import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { monthToDate } from '../domain/period';
import type {
  PeriodRepository,
  PeriodRow,
  PeriodState,
  RunRow,
} from '../domain/ports';
import { monthText } from './sql';

interface PeriodDb {
  month: string;
  status: PeriodState;
  knowledgeCutoff: Date | null;
  closedAt: Date | null;
  shopCount: number | null;
  runId: string | null;
}

const PERIOD_COLUMNS = `${monthText('"month"')} AS month, "status", "knowledgeCutoff", "closedAt", "shopCount", "runId"`;

const toPeriod = (row: PeriodDb): PeriodRow => ({
  month: row.month,
  status: row.status,
  knowledgeCutoff: row.knowledgeCutoff ? new Date(row.knowledgeCutoff) : null,
  closedAt: row.closedAt ? new Date(row.closedAt) : null,
  shopCount: row.shopCount,
  runId: row.runId,
});

/** Accounting periods, close runs and their history over raw SQL; every call joins the caller's transaction (CLS). */
@Injectable()
export class SequelizePeriodRepository implements PeriodRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private select<T extends object>(
    sql: string,
    replacements: Record<string, unknown> = {},
  ) {
    return this.sequelize.query<T>(sql, {
      type: QueryTypes.SELECT,
      replacements,
    });
  }

  private async changed(sql: string, replacements: Record<string, unknown>) {
    const rows = await this.select<{ one: number }>(sql, replacements);
    return rows.length > 0;
  }

  async statusOf(month: string): Promise<PeriodState> {
    const [row] = await this.select<{ status: PeriodState }>(
      `SELECT "status" FROM "AccountingPeriod" WHERE "month" = CAST(:month AS date)`,
      { month: monthToDate(month) },
    );
    return row?.status ?? 'OPEN';
  }

  async find(month: string): Promise<PeriodRow | null> {
    const [row] = await this.select<PeriodDb>(
      `SELECT ${PERIOD_COLUMNS} FROM "AccountingPeriod" WHERE "month" = CAST(:month AS date)`,
      { month: monthToDate(month) },
    );
    return row ? toPeriod(row) : null;
  }

  async list(before: string | null, limit: number): Promise<PeriodRow[]> {
    const rows = await this.select<PeriodDb>(
      `SELECT ${PERIOD_COLUMNS} FROM "AccountingPeriod"
        WHERE CAST(:before AS date) IS NULL OR "month" < CAST(:before AS date)
        ORDER BY "month" DESC LIMIT :limit`,
      { before: before ? monthToDate(before) : null, limit },
    );
    return rows.map(toPeriod);
  }

  async closingOrClosedMonths(): Promise<string[]> {
    const rows = await this.select<{ month: string }>(
      `SELECT ${monthText('"month"')} AS month FROM "AccountingPeriod"
        WHERE "status" IN ('CLOSING','CLOSED') ORDER BY "month"`,
    );
    return rows.map((row) => row.month);
  }

  async statesBetween(
    from: string,
    to: string,
  ): Promise<Map<string, PeriodState>> {
    const rows = await this.select<{ month: string; status: PeriodState }>(
      `SELECT ${monthText('"month"')} AS month, "status" FROM "AccountingPeriod"
        WHERE "month" >= CAST(:from AS date) AND "month" <= CAST(:to AS date)`,
      { from: monthToDate(from), to: monthToDate(to) },
    );
    return new Map(rows.map((row) => [row.month, row.status]));
  }

  async earliestFactMonth(): Promise<string | null> {
    const [row] = await this.select<{ month: string | null }>(
      `SELECT to_char(least(
                (SELECT min(date_trunc('month', "paidAt" AT TIME ZONE 'UTC')) FROM "StatementSaleFact"),
                (SELECT min(date_trunc('month', "paidAt" AT TIME ZONE 'UTC')) FROM "StatementPayoutFact")),
              'YYYY-MM') AS month`,
    );
    return row?.month ?? null;
  }

  async ensureRow(month: string): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO "AccountingPeriod" ("month", "status") VALUES (CAST(:month AS date), 'OPEN')
       ON CONFLICT ("month") DO NOTHING`,
      { replacements: { month: monthToDate(month) } },
    );
  }

  requestClose(month: string, cutoff: Date, runId: string): Promise<boolean> {
    return this.changed(
      `UPDATE "AccountingPeriod" SET "status" = 'CLOSING', "knowledgeCutoff" = CAST(:cutoff AS timestamptz), "runId" = :runId
        WHERE "month" = CAST(:month AS date) AND "status" = 'OPEN' RETURNING 1 AS one`,
      { month: monthToDate(month), cutoff: cutoff.toISOString(), runId },
    );
  }

  finish(
    month: string,
    runId: string,
    shopCount: number,
    closedAt: Date,
  ): Promise<boolean> {
    return this.changed(
      `UPDATE "AccountingPeriod" SET "status" = 'CLOSED', "closedAt" = CAST(:closedAt AS timestamptz), "shopCount" = :shopCount
        WHERE "month" = CAST(:month AS date) AND "status" = 'CLOSING' AND "runId" = :runId RETURNING 1 AS one`,
      {
        month: monthToDate(month),
        runId,
        shopCount,
        closedAt: closedAt.toISOString(),
      },
    );
  }

  reopen(month: string, runId: string): Promise<boolean> {
    return this.changed(
      `UPDATE "AccountingPeriod" SET "status" = 'OPEN', "knowledgeCutoff" = NULL, "runId" = NULL
        WHERE "month" = CAST(:month AS date) AND "status" = 'CLOSING' AND "runId" = :runId RETURNING 1 AS one`,
      { month: monthToDate(month), runId },
    );
  }

  async recordHistory(entry: {
    month: string;
    from: PeriodState;
    to: PeriodState;
    runId: string | null;
    actor: string;
    at: Date;
  }): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO "StatementPeriodHistory" ("month", "fromStatus", "toStatus", "runId", "actor", "at")
       VALUES (CAST(:month AS date), :from, :to, :runId, :actor, CAST(:at AS timestamptz))`,
      {
        replacements: {
          month: monthToDate(entry.month),
          from: entry.from,
          to: entry.to,
          runId: entry.runId,
          actor: entry.actor,
          at: entry.at.toISOString(),
        },
      },
    );
  }

  async createRun(run: {
    runId: string;
    month: string;
    knowledgeCutoff: Date;
    startedAt: Date;
  }): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO "StatementPeriodRun" ("runId", "month", "status", "knowledgeCutoff", "startedAt")
       VALUES (:runId, CAST(:month AS date), 'RUNNING', CAST(:cutoff AS timestamptz), CAST(:startedAt AS timestamptz))`,
      {
        replacements: {
          runId: run.runId,
          month: monthToDate(run.month),
          cutoff: run.knowledgeCutoff.toISOString(),
          startedAt: run.startedAt.toISOString(),
        },
      },
    );
  }

  async progressRun(
    runId: string,
    batches: number,
    shops: number,
  ): Promise<void> {
    await this.sequelize.query(
      `UPDATE "StatementPeriodRun" SET "batchesWritten" = :batches, "shopsWritten" = :shops WHERE "runId" = :runId`,
      { replacements: { runId, batches, shops } },
    );
  }

  async finishRun(
    runId: string,
    status: 'COMPLETED' | 'FAILED',
    failureCode: string | null,
    details: Record<string, unknown> | null,
    finishedAt: Date,
  ): Promise<void> {
    await this.sequelize.query(
      `UPDATE "StatementPeriodRun"
          SET "status" = :status, "failureCode" = :failureCode, "details" = CAST(:details AS jsonb),
              "finishedAt" = CAST(:finishedAt AS timestamptz)
        WHERE "runId" = :runId`,
      {
        replacements: {
          runId,
          status,
          failureCode,
          details: details ? JSON.stringify(details) : null,
          finishedAt: finishedAt.toISOString(),
        },
      },
    );
  }

  async reconciliationState(
    month: string,
  ): Promise<'clean' | 'findings' | 'unverified'> {
    const [row] = await this.select<{ open: boolean; verified: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM "StatementFinding" WHERE "month" = CAST(:month AS date) AND "status" = 'OPEN') AS open,
              EXISTS (SELECT 1 FROM "StatementVerification" WHERE "month" = CAST(:month AS date)) AS verified`,
      { month: monthToDate(month) },
    );
    if (row.open) return 'findings';
    return row.verified ? 'clean' : 'unverified';
  }

  async lastRun(month: string): Promise<RunRow | null> {
    const [row] = await this.select<RunRow & { month: string }>(
      `SELECT "runId", ${monthText('"month"')} AS month, "status", "knowledgeCutoff", "failureCode", "details",
              "batchesWritten", "shopsWritten", "startedAt", "finishedAt"
         FROM "StatementPeriodRun" WHERE "month" = CAST(:month AS date)
        ORDER BY "startedAt" DESC, "runId" DESC LIMIT 1`,
      { month: monthToDate(month) },
    );
    return row
      ? {
          ...row,
          knowledgeCutoff: new Date(row.knowledgeCutoff),
          startedAt: new Date(row.startedAt),
          finishedAt: row.finishedAt ? new Date(row.finishedAt) : null,
        }
      : null;
  }
}
