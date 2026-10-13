import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import type {
  EntryRow,
  JournalHeader,
  JournalStore,
  StoredLine,
} from '../domain/ledger-ports';

interface HeaderRow {
  id: string;
  kind: string;
  reference: string;
  currency: string;
  postedAt: Date;
  fingerprint: string;
  paymentId: string | null;
  orderId: string | null;
  paymentRef: string | null;
  refundRef: string | null;
  userId: string | null;
  clearingMinor: string | null;
  amountMinor: string | null;
  reversesJournalId: string | null;
  correctsDay: string | null;
}

const toHeader = (r: HeaderRow): JournalHeader => ({
  ...r,
  postedAt: new Date(r.postedAt),
  clearingMinor: r.clearingMinor === null ? null : Number(r.clearingMinor),
  amountMinor: r.amountMinor === null ? null : Number(r.amountMinor),
});

const COLUMNS = `"id","kind","reference","currency","postedAt","fingerprint","paymentId","orderId","paymentRef","refundRef","userId","clearingMinor","amountMinor","reversesJournalId","correctsDay"`;

/** Postgres adapter of `JOURNAL_STORE`: the header table decides "once per (kind, reference)" (research R-1). */
@Injectable()
export class SequelizeJournalStore implements JournalStore {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async insertHeader(
    h: JournalHeader,
    tx: Transaction,
  ): Promise<{ created: true } | { created: false; existing: JournalHeader }> {
    const [inserted] = await this.sequelize.query<{ id: string }>(
      `INSERT INTO "LedgerJournal" (${COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT DO NOTHING
       RETURNING "id"`,
      {
        type: QueryTypes.SELECT,
        transaction: tx,
        bind: [
          h.id,
          h.kind,
          h.reference,
          h.currency,
          h.postedAt,
          h.fingerprint,
          h.paymentId,
          h.orderId,
          h.paymentRef,
          h.refundRef,
          h.userId,
          h.clearingMinor,
          h.amountMinor,
          h.reversesJournalId,
          h.correctsDay,
        ],
      },
    );
    if (inserted) return { created: true };
    // A concurrent identical posting committed first: this statement sees its header.
    const existing = await this.findHeader(h.kind, h.reference, tx);
    if (!existing) throw new Error('journal header vanished after a conflict');
    return { created: false, existing };
  }

  async insertEntries(rows: EntryRow[], tx: Transaction): Promise<void> {
    if (rows.length === 0) return;
    const bind: unknown[] = [];
    const tuples = rows.map((r) => {
      const base = bind.length;
      bind.push(
        r.journalId,
        r.kind,
        r.paymentId,
        r.accountId,
        r.shard,
        r.currency,
        String(r.amountMinor),
        r.postedAt,
      );
      return `(${[1, 2, 3, 4, 5, 6, 7, 8].map((i) => `$${base + i}`).join(',')})`;
    });
    await this.sequelize.query(
      `INSERT INTO "LedgerEntry" ("journalId","kind","paymentId","accountId","shard","currency","amount","createdAt")
       VALUES ${tuples.join(',')}`,
      { bind: bind as never, transaction: tx },
    );
  }

  async findHeader(
    kind: string,
    reference: string,
    tx?: Transaction,
  ): Promise<JournalHeader | null> {
    return this.one(
      `SELECT ${COLUMNS} FROM "LedgerJournal" WHERE "kind" = $1 AND "reference" = $2`,
      [kind, reference],
      tx,
    );
  }

  findByPayment(
    kind: 'SALE' | 'REFUND',
    paymentId: string,
    tx?: Transaction,
  ): Promise<JournalHeader | null> {
    return this.one(
      `SELECT ${COLUMNS} FROM "LedgerJournal" WHERE "kind" = $1 AND "paymentId" = $2 LIMIT 1`,
      [kind, paymentId],
      tx,
    );
  }

  findSettlementByOrder(
    orderId: string,
    tx?: Transaction,
  ): Promise<JournalHeader | null> {
    return this.one(
      `SELECT ${COLUMNS} FROM "LedgerJournal" WHERE "kind" = 'SETTLEMENT' AND "orderId" = $1 LIMIT 1`,
      [orderId],
      tx,
    );
  }

  findSaleByOrder(
    orderId: string,
    tx?: Transaction,
  ): Promise<JournalHeader | null> {
    return this.one(
      `SELECT ${COLUMNS} FROM "LedgerJournal" WHERE "kind" = 'SALE' AND "orderId" = $1 LIMIT 1`,
      [orderId],
      tx,
    );
  }

  async entriesOf(journalId: string, tx?: Transaction): Promise<StoredLine[]> {
    const rows = await this.sequelize.query<{
      accountId: string;
      shard: number;
      amount: string;
    }>(
      `SELECT "accountId","shard","amount" FROM "LedgerEntry" WHERE "journalId" = $1 ORDER BY "createdAt","id"`,
      { type: QueryTypes.SELECT, bind: [journalId], transaction: tx },
    );
    return rows.map((r) => ({
      accountId: r.accountId,
      shard: Number(r.shard),
      amountMinor: Number(r.amount),
    }));
  }

  async lockPayment(paymentId: string, tx: Transaction): Promise<void> {
    await this.sequelize.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      { bind: [`pay:${paymentId}`], transaction: tx },
    );
  }

  private async one(
    sql: string,
    bind: unknown[],
    tx?: Transaction,
  ): Promise<JournalHeader | null> {
    const [row] = await this.sequelize.query<HeaderRow>(sql, {
      type: QueryTypes.SELECT,
      bind: bind as never,
      transaction: tx,
    });
    return row ? toHeader(row) : null;
  }
}
