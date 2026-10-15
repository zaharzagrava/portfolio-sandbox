import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, type Transaction } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import type {
  AdminListFilter,
  HistoryRow,
  NewPayout,
  PayoutPatch,
  PayoutRecord,
  PayoutRepository,
} from '../domain/payout-ports';
import type { PayoutStatus } from '../domain/payout-state';
import { safeNumber } from './safe-number';

interface Row {
  id: string;
  shopId: string;
  periodStart: string;
  currency: string;
  amountMinor: string | number;
  reserveHeldMinor: string | number;
  status: PayoutStatus;
  destinationSnapshot: string | null;
  transferRef: string | null;
  failureCode: string | null;
  failureReason: string | null;
  attempts: number;
  resendCount: number;
  lookupFailures: number;
  nextResolveAt: Date | null;
  inDoubtSince: Date | null;
  inDoubtEventAt: Date | null;
  discrepancyReportedAt: Date | null;
  payoutVersion: number;
  submittedAt: Date | null;
  paidAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  createdAtKey: string;
}

const COLUMNS = `"id", "shopId", "periodStart"::text AS "periodStart", "currency",
  coalesce("amountMinor", "amount") AS "amountMinor", "reserveHeldMinor", "status", "destinationSnapshot",
  coalesce("transferRef", "providerRef") AS "transferRef", "failureCode", "failureReason", "attempts", "resendCount",
  "lookupFailures", "nextResolveAt", "inDoubtSince", "inDoubtEventAt", "discrepancyReportedAt", "payoutVersion",
  "submittedAt", "paidAt", "cancelledAt", "createdAt",
  to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAtKey"`;

const toRecord = (r: Row): PayoutRecord => ({
  ...r,
  amountMinor: safeNumber(r.amountMinor),
  reserveHeldMinor: safeNumber(r.reserveHeldMinor),
});

/** The only columns a transition may set next to the status (a whitelist: column names are never caller text). */
const PATCHABLE: ReadonlyArray<keyof PayoutPatch> = [
  'transferRef',
  'failureCode',
  'failureReason',
  'attempts',
  'resendCount',
  'lookupFailures',
  'nextResolveAt',
  'inDoubtSince',
  'submittedAt',
  'paidAt',
  'cancelledAt',
];

function patchSql(patch: PayoutPatch): {
  sql: string;
  replacements: Record<string, unknown>;
} {
  const sets: string[] = [];
  const replacements: Record<string, unknown> = {};
  for (const column of PATCHABLE) {
    const value = patch[column];
    if (value === undefined) continue;
    sets.push(`"${column}" = :p_${column}`);
    replacements[`p_${column}`] = value;
  }
  return { sql: sets.length ? `, ${sets.join(', ')}` : '', replacements };
}

/** The payout table through hand-written statements: conditional updates are the transitions (III.7). */
@Injectable()
export class SequelizePayoutRepository implements PayoutRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private select(
    sql: string,
    replacements: Record<string, unknown>,
    transaction?: Transaction,
  ): Promise<Row[]> {
    return this.sequelize.query<Row>(sql, {
      type: QueryTypes.SELECT,
      replacements,
      transaction,
    });
  }

  async insertIfAbsent(
    p: NewPayout,
    now: Date,
    tx: Transaction,
  ): Promise<string | null> {
    const rows = await this.sequelize.query<{ id: string }>(
      `INSERT INTO "Payout" ("shopId", "periodStart", "currency", "amount", "amountMinor", "reserveHeldMinor",
                             "status", "destinationSnapshot", "payoutVersion", "createdAt", "updatedAt")
       VALUES (:shopId, :periodStart, :currency, :amount, :amount, :reserve, 'PENDING', :destination, 1, :now, :now)
       ON CONFLICT ("shopId", "periodStart") DO NOTHING RETURNING "id"`,
      {
        type: QueryTypes.SELECT,
        transaction: tx,
        replacements: {
          shopId: p.shopId,
          periodStart: p.periodStart,
          currency: p.currency,
          amount: p.amountMinor,
          reserve: p.reserveHeldMinor,
          destination: p.destinationSnapshot,
          now,
        },
      },
    );
    return rows[0]?.id ?? null;
  }

  async findById(id: string, tx?: Transaction): Promise<PayoutRecord | null> {
    const rows = await this.select(
      `SELECT ${COLUMNS} FROM "Payout" WHERE "id" = :id`,
      { id },
      tx,
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findForShop(id: string, shopId: string): Promise<PayoutRecord | null> {
    const rows = await this.select(
      `SELECT ${COLUMNS} FROM "Payout" WHERE "id" = :id AND "shopId" = :shopId`,
      { id, shopId },
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async transition(
    id: string,
    from: readonly PayoutStatus[],
    to: PayoutStatus,
    patch: PayoutPatch,
    now: Date,
    tx: Transaction,
  ): Promise<PayoutRecord | null> {
    const { sql, replacements } = patchSql(patch);
    const rows = await this.select(
      `UPDATE "Payout" SET "status" = :to, "payoutVersion" = "payoutVersion" + 1, "updatedAt" = :now${sql}
        WHERE "id" = :id AND "status" IN (:from) RETURNING ${COLUMNS}`,
      { ...replacements, id, to, from: [...from], now },
      tx,
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async takeAttempt(
    id: string,
    attempt: number,
    tx: Transaction,
  ): Promise<boolean> {
    const rows = await this.select(
      `UPDATE "Payout" SET "attempts" = :attempt, "updatedAt" = now()
        WHERE "id" = :id AND "status" = 'SENDING' AND "attempts" < :attempt RETURNING "id"`,
      { id, attempt },
      tx,
    );
    return rows.length === 1;
  }

  async markOnce(
    id: string,
    column: 'inDoubtEventAt' | 'discrepancyReportedAt',
    now: Date,
    tx: Transaction,
  ): Promise<boolean> {
    const rows = await this.select(
      `UPDATE "Payout" SET "${column}" = :now WHERE "id" = :id AND "${column}" IS NULL RETURNING "id"`,
      { id, now },
      tx,
    );
    return rows.length === 1;
  }

  async updateWhileInDoubt(
    id: string,
    patch: PayoutPatch,
    now: Date,
    tx?: Transaction,
  ): Promise<void> {
    const { sql, replacements } = patchSql(patch);
    await this.sequelize.query(
      `UPDATE "Payout" SET "updatedAt" = :now${sql}
        WHERE "id" = :id AND "status" IN ('SENDING','UNKNOWN')`,
      { replacements: { ...replacements, id, now }, transaction: tx },
    );
  }

  async appendHistory(row: HistoryRow, tx: Transaction): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO "PayoutHistory" ("payoutId", "fromStatus", "toStatus", "payoutVersion", "actor", "reason", "at")
       VALUES (:payoutId, :fromStatus, :toStatus, :payoutVersion, :actor, :reason, :at)`,
      { transaction: tx, replacements: { ...row } },
    );
  }

  async timeline(
    payoutId: string,
  ): Promise<{ toStatus: PayoutStatus; at: Date }[]> {
    return this.sequelize.query<{ toStatus: PayoutStatus; at: Date }>(
      `SELECT "toStatus", "at" FROM "PayoutHistory" WHERE "payoutId" = :payoutId ORDER BY "id"`,
      { type: QueryTypes.SELECT, replacements: { payoutId } },
    );
  }

  async listForShop(
    shopId: string,
    page: { limit: number; after?: { k: string; id: string } },
  ): Promise<PayoutRecord[]> {
    const rows = await this.select(
      `SELECT ${COLUMNS} FROM "Payout"
        WHERE "shopId" = :shopId
          ${page.after ? `AND ("periodStart", "id") < (CAST(:k AS date), CAST(:cursorId AS uuid))` : ''}
        ORDER BY "periodStart" DESC, "id" DESC LIMIT :limit`,
      {
        shopId,
        limit: page.limit,
        k: page.after?.k,
        cursorId: page.after?.id,
      },
    );
    return rows.map(toRecord);
  }

  async listAll(
    filter: AdminListFilter,
    page: { limit: number; after?: { k: string; id: string } },
  ): Promise<PayoutRecord[]> {
    const where: string[] = [];
    if (filter.status) where.push(`"status" = :status`);
    if (filter.shopId) where.push(`"shopId" = :shopId`);
    if (filter.periodStart)
      where.push(`"periodStart" = CAST(:periodStart AS date)`);
    if (page.after)
      where.push(
        `("createdAt", "id") < (CAST(:k AS timestamptz), CAST(:cursorId AS uuid))`,
      );
    const rows = await this.select(
      `SELECT ${COLUMNS} FROM "Payout" ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY "createdAt" DESC, "id" DESC LIMIT :limit`,
      {
        status: filter.status,
        shopId: filter.shopId,
        periodStart: filter.periodStart,
        limit: page.limit,
        k: page.after?.k,
        cursorId: page.after?.id,
      },
    );
    return rows.map(toRecord);
  }

  async dueForResolution(
    now: Date,
    staleBefore: Date,
    limit: number,
  ): Promise<PayoutRecord[]> {
    const rows = await this.select(
      `SELECT ${COLUMNS} FROM "Payout"
        WHERE ("status" = 'UNKNOWN' OR ("status" = 'SENDING' AND "updatedAt" < :staleBefore))
          AND ("nextResolveAt" IS NULL OR "nextResolveAt" <= :now)
        ORDER BY "nextResolveAt" NULLS FIRST, "id" LIMIT :limit`,
      { now, staleBefore, limit },
    );
    return rows.map(toRecord);
  }

  async oldestInDoubtSince(): Promise<Date | null> {
    const rows = await this.sequelize.query<{ since: Date | null }>(
      `SELECT min("inDoubtSince") AS since FROM "Payout"
        WHERE "status" IN ('SENDING','UNKNOWN') AND "inDoubtSince" IS NOT NULL`,
      { type: QueryTypes.SELECT },
    );
    return rows[0]?.since ?? null;
  }

  async paidBetween(
    from: Date,
    to: Date,
    after: string | null,
    limit: number,
  ): Promise<PayoutRecord[]> {
    const rows = await this.select(
      `SELECT ${COLUMNS} FROM "Payout"
        WHERE "status" = 'PAID' AND "paidAt" >= :from AND "paidAt" < :to
          ${after ? `AND "id" > CAST(:after AS uuid)` : ''}
        ORDER BY "id" LIMIT :limit`,
      { from, to, after, limit },
    );
    return rows.map(toRecord);
  }
}
