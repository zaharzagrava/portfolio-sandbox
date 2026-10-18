import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type { InvoiceCursor } from '../domain/cursor';
import type { InvoiceStatus } from '../domain/invoice-status';
import { MAX_ATTEMPTS } from '../domain/dunning-schedule';
import type {
  AttemptKind,
  InvoicePage,
  InvoiceRepository,
  NewInvoice,
} from '../domain/ports';
import type {
  InvoiceKind,
  InvoiceLineKind,
  InvoiceLineRow,
  InvoiceRow,
  Subject,
} from '../domain/types';
import { dateOrNull, isoMicros, minor, run, select } from './sql';

interface InvoiceDb {
  id: string;
  subscriptionId: string;
  kind: InvoiceKind;
  businessKey: string;
  periodStart: Date;
  periodEnd: Date;
  status: InvoiceStatus;
  total: string;
  currency: string;
  attempts: number;
  attemptStartedAt: Date | null;
  attemptRef: string | null;
  attemptUnknown: boolean;
  manualAttempts: number;
  firstFailedAt: Date | null;
  nextAttemptAt: Date | null;
  usageMeasuredAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
  createdAtKey?: string;
}

const COLUMNS = `i."id", i."subscriptionId", i."kind", i."businessKey", i."periodStart", i."periodEnd", i."status",
  i."total", i."currency", i."attempts", i."attemptStartedAt", i."attemptRef", i."attemptUnknown", i."manualAttempts",
  i."firstFailedAt", i."nextAttemptAt", i."usageMeasuredAt", i."paidAt", i."createdAt"`;
/** The same columns without the alias, for `UPDATE ... RETURNING`. */
const RETURNING = COLUMNS.replace(/i\./g, '');

const toInvoice = (row: InvoiceDb): InvoiceRow => ({
  id: row.id,
  subscriptionId: row.subscriptionId,
  kind: row.kind,
  businessKey: row.businessKey,
  periodStart: new Date(row.periodStart),
  periodEnd: new Date(row.periodEnd),
  status: row.status,
  totalMinor: minor(row.total),
  currency: row.currency,
  attempts: row.attempts,
  attemptStartedAt: dateOrNull(row.attemptStartedAt),
  attemptRef: row.attemptRef,
  attemptUnknown: row.attemptUnknown,
  manualAttempts: row.manualAttempts,
  firstFailedAt: dateOrNull(row.firstFailedAt),
  nextAttemptAt: dateOrNull(row.nextAttemptAt),
  usageMeasuredAt: dateOrNull(row.usageMeasuredAt),
  paidAt: dateOrNull(row.paidAt),
  createdAt: new Date(row.createdAt),
});

/** Invoices, lines, attempts and the status history over raw SQL; the store's triggers back every rule written here. */
@Injectable()
export class SequelizeInvoiceRepository implements InvoiceRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private async one(
    sql: string,
    replacements: Record<string, unknown>,
  ): Promise<InvoiceRow | null> {
    const [row] = await select<InvoiceDb>(this.sequelize, sql, replacements);
    return row ? toInvoice(row) : null;
  }

  private transition(
    invoiceId: string,
    from: string,
    to: string,
    reason: string,
    at: Date,
  ) {
    return run(
      this.sequelize,
      `INSERT INTO "InvoiceTransition" ("invoiceId", "fromStatus", "toStatus", "reason", "at")
       VALUES (:invoiceId, :from, :to, :reason, :at)`,
      { invoiceId, from, to, reason, at },
    );
  }

  async insertWithLines(invoice: NewInvoice, lines: InvoiceLineRow[]) {
    const inserted = await this.one(
      `INSERT INTO "Invoice" ("subscriptionId", "kind", "businessKey", "periodStart", "periodEnd", "status", "total",
                              "currency", "usageMeasuredAt", "paidAt", "createdAt", "updatedAt")
       VALUES (:subscriptionId, :kind, :businessKey, :periodStart, :periodEnd, :status, :total, :currency,
               :usageMeasuredAt, :paidAt, :now, :now)
       ON CONFLICT ("subscriptionId", "businessKey") DO NOTHING
       RETURNING ${RETURNING}`,
      {
        subscriptionId: invoice.subscriptionId,
        kind: invoice.kind,
        businessKey: invoice.businessKey,
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
        status: invoice.status,
        total: invoice.totalMinor,
        currency: invoice.currency,
        usageMeasuredAt: invoice.usageMeasuredAt,
        paidAt: invoice.status === 'PAID' ? invoice.now : null,
        now: invoice.now,
      },
    );
    if (!inserted) {
      const existing = await this.one(
        `SELECT ${COLUMNS} FROM "Invoice" i WHERE i."subscriptionId" = :subscriptionId AND i."businessKey" = :businessKey`,
        {
          subscriptionId: invoice.subscriptionId,
          businessKey: invoice.businessKey,
        },
      );
      if (!existing) throw new Error('invoice vanished after a key conflict');
      return { invoice: existing, created: false };
    }
    if (lines.length > 0) {
      const replacements: Record<string, unknown> = { invoiceId: inserted.id };
      const values = lines.map((line, index) => {
        replacements[`k${index}`] = line.kind;
        replacements[`d${index}`] = line.description;
        replacements[`q${index}`] = line.quantity;
        replacements[`a${index}`] = line.amountMinor;
        return `(:invoiceId, :k${index}, :d${index}, :q${index}, :a${index})`;
      });
      await run(
        this.sequelize,
        `INSERT INTO "InvoiceLine" ("invoiceId", "kind", "description", "quantity", "amount") VALUES ${values.join(', ')}`,
        replacements,
      );
    }
    return { invoice: inserted, created: true };
  }

  findById(id: string) {
    return this.one(`SELECT ${COLUMNS} FROM "Invoice" i WHERE i."id" = :id`, {
      id,
    });
  }

  async lines(invoiceId: string) {
    const rows = await select<{
      kind: InvoiceLineKind;
      description: string;
      quantity: string;
      amount: string;
    }>(
      this.sequelize,
      `SELECT "kind", "description", "quantity", "amount" FROM "InvoiceLine" WHERE "invoiceId" = :invoiceId
        ORDER BY "id"`,
      { invoiceId },
    );
    return rows.map((row) => ({
      kind: row.kind,
      description: row.description,
      quantity: minor(row.quantity),
      amountMinor: minor(row.amount),
    }));
  }

  latestFor(subscriptionId: string) {
    return this.one(
      `SELECT ${COLUMNS} FROM "Invoice" i WHERE i."subscriptionId" = :subscriptionId
        ORDER BY i."createdAt" DESC, i."id" DESC LIMIT 1`,
      { subscriptionId },
    );
  }

  oldestOwed(subscriptionId: string) {
    return this.one(
      `SELECT ${COLUMNS} FROM "Invoice" i
        WHERE i."subscriptionId" = :subscriptionId AND i."status" IN ('OPEN','UNCOLLECTIBLE') AND i."total" > 0
        ORDER BY i."createdAt", i."id" LIMIT 1`,
      { subscriptionId },
    );
  }

  async countOwed(subscriptionId: string) {
    const [row] = await select<{ n: string }>(
      this.sequelize,
      `SELECT count(*) AS n FROM "Invoice"
        WHERE "subscriptionId" = :subscriptionId AND "status" IN ('OPEN','UNCOLLECTIBLE') AND "total" > 0`,
      { subscriptionId },
    );
    return Number(row?.n ?? 0);
  }

  async countBilled(subscriptionId: string) {
    const [row] = await select<{ n: string }>(
      this.sequelize,
      `SELECT count(*) AS n FROM "Invoice" WHERE "subscriptionId" = :subscriptionId AND "total" > 0`,
      { subscriptionId },
    );
    return Number(row?.n ?? 0);
  }

  async countPaid(subscriptionId: string) {
    const [row] = await select<{ n: string }>(
      this.sequelize,
      `SELECT count(*) AS n FROM "Invoice"
        WHERE "subscriptionId" = :subscriptionId AND "status" = 'PAID' AND "total" > 0`,
      { subscriptionId },
    );
    return Number(row?.n ?? 0);
  }

  previousRenewal(subscriptionId: string, before: Date) {
    return this.one(
      `SELECT ${COLUMNS} FROM "Invoice" i
        WHERE i."subscriptionId" = :subscriptionId AND i."kind" = 'RENEWAL' AND i."periodStart" < :before
        ORDER BY i."periodStart" DESC LIMIT 1`,
      { subscriptionId, before },
    );
  }

  claimAttempt(id: string, kind: AttemptKind, now: Date) {
    if (kind.type === 'numbered')
      return this.one(
        `UPDATE "Invoice" SET "attempts" = "attempts" + 1, "attemptStartedAt" = :now,
                "attemptRef" = CAST("attempts" + 1 AS text), "updatedAt" = :now
          WHERE "id" = :id AND "status" = 'OPEN' AND "attemptStartedAt" IS NULL AND "total" > 0
            AND "attempts" < :maxAttempts AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= :now)
          RETURNING ${RETURNING}`,
        { id, now, maxAttempts: MAX_ATTEMPTS },
      );
    return this.one(
      `UPDATE "Invoice" SET "manualAttempts" = "manualAttempts" + 1, "attemptStartedAt" = :now,
              "attemptRef" = 'manual:' || ("manualAttempts" + 1), "updatedAt" = :now
        WHERE "id" = :id AND "status" IN ('OPEN','UNCOLLECTIBLE') AND "attemptStartedAt" IS NULL AND "total" > 0
          AND "manualAttempts" = :previous
        RETURNING ${RETURNING}`,
      { id, now, previous: kind.k - 1 },
    );
  }

  async settlePaid(id: string, attemptRef: string, now: Date) {
    // The status it leaves is read under the row lock, because the history row names both ends of the move.
    const [current] = await select<{ status: string }>(
      this.sequelize,
      `SELECT "status" FROM "Invoice" WHERE "id" = :id AND "attemptRef" = :attemptRef FOR UPDATE`,
      { id, attemptRef },
    );
    if (!current) return null;
    const row = await this.one(
      `UPDATE "Invoice" SET "status" = 'PAID', "paidAt" = :now, "attemptStartedAt" = NULL, "attemptRef" = NULL,
                            "attemptUnknown" = FALSE, "nextAttemptAt" = NULL, "updatedAt" = :now
        WHERE "id" = :id AND "attemptRef" = :attemptRef AND "status" IN ('OPEN','UNCOLLECTIBLE')
        RETURNING ${RETURNING}`,
      { id, attemptRef, now },
    );
    if (!row) return null;
    await this.transition(id, current.status, 'PAID', 'paid', now);
    return row;
  }

  async settleFailed(
    id: string,
    input: {
      attemptRef: string;
      now: Date;
      firstFailedAt: Date;
      nextAttemptAt: Date | null;
      uncollectible: boolean;
    },
  ) {
    if (input.attemptRef.startsWith('manual:'))
      return this.one(
        `UPDATE "Invoice" SET "attemptStartedAt" = NULL, "attemptRef" = NULL, "attemptUnknown" = FALSE,
                "updatedAt" = :now
          WHERE "id" = :id AND "attemptRef" = :attemptRef AND "status" IN ('OPEN','UNCOLLECTIBLE')
          RETURNING ${RETURNING}`,
        { id, attemptRef: input.attemptRef, now: input.now },
      );
    const row = await this.one(
      `UPDATE "Invoice" SET "attemptStartedAt" = NULL, "attemptRef" = NULL, "attemptUnknown" = FALSE,
              "firstFailedAt" = coalesce("firstFailedAt", :firstFailedAt), "nextAttemptAt" = :nextAttemptAt,
              "status" = CASE WHEN :uncollectible THEN 'UNCOLLECTIBLE' ELSE "status" END, "updatedAt" = :now
        WHERE "id" = :id AND "attemptRef" = :attemptRef AND "status" = 'OPEN'
        RETURNING ${RETURNING}`,
      {
        id,
        attemptRef: input.attemptRef,
        now: input.now,
        firstFailedAt: input.firstFailedAt,
        nextAttemptAt: input.nextAttemptAt,
        uncollectible: input.uncollectible,
      },
    );
    if (row && input.uncollectible)
      await this.transition(
        id,
        'OPEN',
        'UNCOLLECTIBLE',
        'dunning_exhausted',
        input.now,
      );
    return row;
  }

  async markUnknown(id: string, attemptRef: string, now: Date) {
    const rows = await select<{ id: string }>(
      this.sequelize,
      `UPDATE "Invoice" SET "attemptUnknown" = TRUE, "updatedAt" = :now
        WHERE "id" = :id AND "attemptRef" = :attemptRef RETURNING "id"`,
      { id, attemptRef, now },
    );
    return rows.length > 0;
  }

  async writeOffOpen(subscriptionId: string, now: Date, reason: string) {
    const rows = await select<{ n: number }>(
      this.sequelize,
      `WITH moved AS (
         UPDATE "Invoice" SET "status" = 'UNCOLLECTIBLE', "nextAttemptAt" = NULL, "updatedAt" = :now
          WHERE "subscriptionId" = :subscriptionId AND "status" = 'OPEN' RETURNING "id"
       ), history AS (
         INSERT INTO "InvoiceTransition" ("invoiceId", "fromStatus", "toStatus", "reason", "at")
         SELECT "id", 'OPEN', 'UNCOLLECTIBLE', :reason, :now FROM moved RETURNING 1
       )
       SELECT (SELECT count(*) FROM moved)::int AS n`,
      { subscriptionId, now, reason },
    );
    return rows[0]?.n ?? 0;
  }

  async list(
    subject: Subject,
    limit: number,
    after: InvoiceCursor | null,
  ): Promise<InvoicePage> {
    const rows = await select<InvoiceDb>(
      this.sequelize,
      `SELECT ${COLUMNS}, ${isoMicros('i."createdAt"')} AS "createdAtKey"
         FROM "Invoice" i JOIN "Subscription" s ON s."id" = i."subscriptionId"
        WHERE s."subjectType" = :subjectType AND s."subjectId" = :subjectId
          AND (CAST(:afterCreated AS timestamptz) IS NULL
               OR (i."createdAt", i."id") < (CAST(:afterCreated AS timestamptz), CAST(:afterId AS uuid)))
        ORDER BY i."createdAt" DESC, i."id" DESC LIMIT :fetch`,
      {
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        afterCreated: after?.createdAt ?? null,
        afterId: after?.id ?? null,
        fetch: limit + 1,
      },
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toInvoice),
      next:
        rows.length > limit && last?.createdAtKey
          ? { createdAt: last.createdAtKey, id: last.id }
          : null,
    };
  }

  findForSubject(subject: Subject, invoiceId: string) {
    return this.one(
      `SELECT ${COLUMNS}
         FROM "Invoice" i JOIN "Subscription" s ON s."id" = i."subscriptionId"
        WHERE s."subjectType" = :subjectType AND s."subjectId" = :subjectId AND i."id" = :invoiceId`,
      {
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        invoiceId,
      },
    );
  }

  async countUnknownAttempts() {
    const [row] = await select<{ n: string }>(
      this.sequelize,
      `SELECT count(*) AS n FROM "Invoice" WHERE "attemptUnknown"`,
    );
    return Number(row?.n ?? 0);
  }
}
