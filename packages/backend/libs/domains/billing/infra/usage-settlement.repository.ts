import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type { SettlementRepository } from '../domain/ports';
import type { SettlementRow } from '../domain/usage-types';
import { minor, select } from './sql';

interface Row {
  id: string;
  subscriptionId: string;
  periodStart: Date;
  periodEnd: Date;
  metric: string;
  settledQuantity: string;
  settledAmountMinor: string;
  includedQuantity: string;
  overagePer1000Minor: string;
  lastInvoiceId: string;
  closed: boolean;
}

const COLUMNS = `"id", "subscriptionId", "periodStart", "periodEnd", "metric", "settledQuantity", "settledAmountMinor",
  "includedQuantity", "overagePer1000Minor", "lastInvoiceId", "closed"`;

const toRow = (row: Row): SettlementRow => ({
  id: row.id,
  subscriptionId: row.subscriptionId,
  periodStart: new Date(row.periodStart),
  periodEnd: new Date(row.periodEnd),
  metric: row.metric,
  settledQuantity: minor(row.settledQuantity),
  settledAmountMinor: minor(row.settledAmountMinor),
  includedQuantity: minor(row.includedQuantity),
  overagePer1000Minor: minor(row.overagePer1000Minor),
  lastInvoiceId: row.lastInvoiceId,
  closed: row.closed,
});

/**
 * The settlement ledger (S18 FR-026, FR-028). Every write joins the caller's transaction (CLS) and is a conditional
 * statement: the first settlement of a `(period, metric)` is an `INSERT … ON CONFLICT DO NOTHING`, a later one is an
 * `UPDATE … WHERE settledQuantity = :from`, so of two concurrent settlements exactly one changes the row (III.6).
 */
@Injectable()
export class SequelizeSettlementRepository implements SettlementRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async findOpen(subscriptionId: string): Promise<SettlementRow[]> {
    const rows = await select<Row>(
      this.sequelize,
      `SELECT ${COLUMNS} FROM "UsageSettlement"
        WHERE "subscriptionId" = :subscriptionId AND "closed" = FALSE
        ORDER BY "metric", "periodStart"`,
      { subscriptionId },
    );
    return rows.map(toRow);
  }

  async find(
    subscriptionId: string,
    periodStart: Date,
    metric: string,
  ): Promise<SettlementRow | null> {
    const [row] = await select<Row>(
      this.sequelize,
      `SELECT ${COLUMNS} FROM "UsageSettlement"
        WHERE "subscriptionId" = :subscriptionId AND "periodStart" = :periodStart AND "metric" = :metric`,
      { subscriptionId, periodStart, metric },
    );
    return row ? toRow(row) : null;
  }

  async insertFirst(
    row: Omit<SettlementRow, 'id'>,
    now: Date,
  ): Promise<boolean> {
    const inserted = await select<{ id: string }>(
      this.sequelize,
      `INSERT INTO "UsageSettlement" ("subscriptionId", "periodStart", "periodEnd", "metric", "settledQuantity",
                                      "settledAmountMinor", "includedQuantity", "overagePer1000Minor",
                                      "lastInvoiceId", "closed", "createdAt", "updatedAt")
       VALUES (:subscriptionId, :periodStart, :periodEnd, :metric, :settledQuantity, :settledAmountMinor,
               :includedQuantity, :overagePer1000Minor, :lastInvoiceId, :closed, :now, :now)
       ON CONFLICT ("subscriptionId", "periodStart", "metric") DO NOTHING
       RETURNING "id"`,
      { ...row, now },
    );
    return inserted.length === 1;
  }

  async advance(
    subscriptionId: string,
    periodStart: Date,
    metric: string,
    fromQuantity: number,
    to: {
      quantity: number;
      amountMinor: number;
      invoiceId: string;
      closed: boolean;
    },
    now: Date,
  ): Promise<boolean> {
    const moved = await select<{ id: string }>(
      this.sequelize,
      `UPDATE "UsageSettlement"
          SET "settledQuantity" = :quantity, "settledAmountMinor" = :amountMinor, "lastInvoiceId" = :invoiceId,
              "closed" = ("closed" OR :closed), "updatedAt" = :now
        WHERE "subscriptionId" = :subscriptionId AND "periodStart" = :periodStart AND "metric" = :metric
          AND "settledQuantity" = :fromQuantity AND "closed" = FALSE
       RETURNING "id"`,
      {
        subscriptionId,
        periodStart,
        metric,
        fromQuantity,
        quantity: to.quantity,
        amountMinor: to.amountMinor,
        invoiceId: to.invoiceId,
        closed: to.closed,
        now,
      },
    );
    return moved.length === 1;
  }

  async scanOpen(
    after: string | null,
    limit: number,
  ): Promise<SettlementRow[]> {
    const rows = await select<Row>(
      this.sequelize,
      `SELECT ${COLUMNS} FROM "UsageSettlement"
        WHERE "closed" = FALSE AND (CAST(:after AS uuid) IS NULL OR "id" > CAST(:after AS uuid))
        ORDER BY "id" LIMIT :limit`,
      { after, limit },
    );
    return rows.map(toRow);
  }

  async subjectOf(subscriptionId: string): Promise<string | null> {
    const [row] = await select<{ subjectId: string }>(
      this.sequelize,
      `SELECT "subjectId" FROM "Subscription" WHERE "id" = :subscriptionId`,
      { subscriptionId },
    );
    return row?.subjectId ?? null;
  }
}
