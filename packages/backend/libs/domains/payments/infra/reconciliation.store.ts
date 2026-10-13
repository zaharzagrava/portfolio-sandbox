import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import type {
  ReconciliationIssue,
  ReconciliationRun,
} from '@marketplace-sandbox/contracts';
import type {
  ClaimResult,
  LedgerSideRecord,
  OpenMissingIssue,
  ReconciliationStore,
  RunRecord,
  TimeKey,
} from '../domain/ledger-ports';

interface RunRow {
  id: string;
  provider: string;
  day: string;
  status: RunRecord['status'];
  startedAt: Date;
  leaseUntil: Date | null;
  failureCode: string | null;
  providerLines: number;
  ledgerJournals: number;
  matched: number;
  issues: number;
  skipped: number;
  finishedAt: Date | null;
  inserted?: boolean;
}

const RUN_COLUMNS = `"id","provider","day"::text AS "day","status","startedAt","leaseUntil","failureCode","providerLines","ledgerJournals","matched","issues","skipped","finishedAt"`;

/** A timestamp as text with microseconds, so a keyset cursor compares exactly what Postgres stored. */
const PG_TIME = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

interface IssueRow {
  id: string;
  runId: string;
  day: string;
  kind: ReconciliationIssue['kind'];
  reference: string;
  details: Record<string, unknown>;
  status: 'OPEN' | 'RESOLVED';
  resolution: ReconciliationIssue['resolution'];
  note: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  adjustmentJournalId: string | null;
  createdAt: Date;
}

const ISSUE_COLUMNS = `"id","runId","day"::text AS "day","kind","reference","details","status","resolution","note","resolvedBy","resolvedAt","adjustmentJournalId","createdAt"`;

const toIssue = (r: IssueRow): ReconciliationIssue => ({
  ...r,
  resolvedAt: r.resolvedAt ? new Date(r.resolvedAt).toISOString() : null,
  createdAt: new Date(r.createdAt).toISOString(),
});

const toRun = ({ inserted: _inserted, ...r }: RunRow): RunRecord => ({
  ...r,
  startedAt: new Date(r.startedAt),
  leaseUntil: r.leaseUntil ? new Date(r.leaseUntil) : null,
  finishedAt: r.finishedAt ? new Date(r.finishedAt) : null,
});

/**
 * Postgres adapter of `RECONCILIATION_STORE`: the run record with its lease, the staged issues and seen references,
 * the one promotion transaction, and read-only lookups of the ledger's `SALE`/`REFUND` headers by provider reference.
 */
@Injectable()
export class SequelizeReconciliationStore implements ReconciliationStore {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async claim(input: {
    provider: string;
    day: string;
    now: Date;
    leaseUntil: Date;
  }): Promise<ClaimResult> {
    const [claimed] = await this.sequelize.query<RunRow>(
      `INSERT INTO "ReconciliationRun" ("provider","day","status","startedAt","leaseUntil")
       VALUES ($1,$2,'RUNNING',$3,$4)
       ON CONFLICT ("provider","day") DO UPDATE
         SET "status" = 'RUNNING', "startedAt" = EXCLUDED."startedAt", "leaseUntil" = EXCLUDED."leaseUntil",
             "failureCode" = NULL, "finishedAt" = NULL, "matched" = 0, "issues" = 0,
             "providerLines" = 0, "ledgerJournals" = 0, "skipped" = 0
         WHERE "ReconciliationRun"."status" = 'FAILED'
            OR ("ReconciliationRun"."status" = 'RUNNING' AND "ReconciliationRun"."leaseUntil" < $3)
       RETURNING ${RUN_COLUMNS}, (xmax = 0) AS "inserted"`,
      {
        type: QueryTypes.SELECT,
        bind: [input.provider, input.day, input.now, input.leaseUntil],
      },
    );
    if (claimed) {
      const run = toRun(claimed);
      // A restart begins the day again: scratch rows and issues of the abandoned attempt go (research R-9).
      if (!claimed.inserted) {
        await this.sequelize.query(
          `DELETE FROM "ReconciliationIssue" WHERE "runId" = $1 AND "status" = 'OPEN'`,
          { bind: [run.id] },
        );
        await this.purgeScratch(run.id);
      }
      return { kind: 'claimed', run };
    }
    const [existing] = await this.sequelize.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM "ReconciliationRun" WHERE "provider" = $1 AND "day" = $2`,
      { type: QueryTypes.SELECT, bind: [input.provider, input.day] },
    );
    const run = toRun(existing);
    return run.status === 'COMPLETED'
      ? { kind: 'completed', run }
      : { kind: 'running', run };
  }

  async extendLease(run: RunRecord, leaseUntil: Date): Promise<boolean> {
    const rows = await this.sequelize.query(
      `UPDATE "ReconciliationRun" SET "leaseUntil" = $3
        WHERE "id" = $1 AND "startedAt" = $2 AND "status" = 'RUNNING' RETURNING 1`,
      { type: QueryTypes.SELECT, bind: [run.id, run.startedAt, leaseUntil] },
    );
    return rows.length > 0;
  }

  async stageIssues(
    runId: string,
    issues: {
      kind: string;
      reference: string;
      details: Record<string, unknown>;
    }[],
  ): Promise<void> {
    if (issues.length === 0) return;
    await this.sequelize.query(
      `INSERT INTO "ReconciliationStaging" ("runId","kind","reference","details")
       SELECT $1, k, r, d::jsonb FROM unnest($2::text[], $3::text[], $4::text[]) AS t(k, r, d)
       ON CONFLICT ("runId","kind","reference") DO UPDATE SET "details" = EXCLUDED."details"`,
      {
        bind: [
          runId,
          issues.map((i) => i.kind),
          issues.map((i) => i.reference),
          issues.map((i) => JSON.stringify(i.details)),
        ],
      },
    );
  }

  async markSeen(runId: string, references: string[]): Promise<void> {
    if (references.length === 0) return;
    await this.sequelize.query(
      `INSERT INTO "ReconciliationSeen" ("runId","reference")
       SELECT $1, r FROM unnest($2::text[]) AS t(r) ON CONFLICT DO NOTHING`,
      { bind: [runId, references] },
    );
  }

  async ledgerSides(references: string[]): Promise<LedgerSideRecord[]> {
    if (references.length === 0) return [];
    const rows = await this.sequelize.query<{
      kind: 'SALE' | 'REFUND';
      reference: string;
      amountMinor: string | null;
      currency: string;
    }>(
      `SELECT 'SALE' AS "kind", "paymentRef" AS "reference", "amountMinor"::text AS "amountMinor", trim("currency") AS "currency"
         FROM "LedgerJournal" WHERE "kind" = 'SALE' AND "paymentRef" = ANY($1::text[])
       UNION ALL
       SELECT 'REFUND', "refundRef", "amountMinor"::text, trim("currency")
         FROM "LedgerJournal" WHERE "kind" = 'REFUND' AND "refundRef" = ANY($1::text[])`,
      { type: QueryTypes.SELECT, bind: [references] },
    );
    return rows.map((r) => ({
      kind: r.kind,
      reference: r.reference,
      amountMinor: r.amountMinor === null ? -1 : Number(r.amountMinor),
      currency: r.currency,
    }));
  }

  async countDayJournals(
    fromInclusive: Date,
    toExclusive: Date,
  ): Promise<number> {
    const [row] = await this.sequelize.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "LedgerJournal"
        WHERE "kind" IN ('SALE','REFUND') AND "postedAt" >= $1 AND "postedAt" < $2`,
      { type: QueryTypes.SELECT, bind: [fromInclusive, toExclusive] },
    );
    return Number(row.n);
  }

  async unseenJournals(input: {
    runId: string;
    fromInclusive: Date;
    toExclusive: Date;
    afterId: string | null;
    limit: number;
  }): Promise<(LedgerSideRecord & { id: string })[]> {
    const rows = await this.sequelize.query<{
      id: string;
      kind: 'SALE' | 'REFUND';
      reference: string | null;
      amountMinor: string | null;
      currency: string;
    }>(
      `SELECT j."id", j."kind",
              CASE j."kind" WHEN 'SALE' THEN j."paymentRef" ELSE j."refundRef" END AS "reference",
              j."amountMinor"::text AS "amountMinor", trim(j."currency") AS "currency"
         FROM "LedgerJournal" j
        WHERE j."kind" IN ('SALE','REFUND') AND j."postedAt" >= $2 AND j."postedAt" < $3
          AND ($4::uuid IS NULL OR j."id" > $4::uuid)
          AND NOT EXISTS (
            SELECT 1 FROM "ReconciliationSeen" s
             WHERE s."runId" = $1
               AND s."reference" = CASE j."kind" WHEN 'SALE' THEN j."paymentRef" ELSE j."refundRef" END)
        ORDER BY j."id" LIMIT $5`,
      {
        type: QueryTypes.SELECT,
        bind: [
          input.runId,
          input.fromInclusive,
          input.toExclusive,
          input.afterId,
          input.limit,
        ],
      },
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      reference: r.reference ?? `journal:${r.id}`,
      amountMinor: r.amountMinor === null ? -1 : Number(r.amountMinor),
      currency: r.currency,
    }));
  }

  async openMissingIssues(
    fromDay: string,
    toDayExclusive: string,
  ): Promise<OpenMissingIssue[]> {
    return this.sequelize.query<OpenMissingIssue>(
      `SELECT "id", "kind", "reference", "details" FROM "ReconciliationIssue"
        WHERE "status" = 'OPEN' AND "kind" IN ('MISSING_IN_LEDGER','MISSING_AT_PROVIDER')
          AND "day" >= $1 AND "day" < $2
        ORDER BY "day", "id"`,
      { type: QueryTypes.SELECT, bind: [fromDay, toDayExclusive] },
    );
  }

  async promoteStaged(
    run: RunRecord,
    now: Date,
    tx: Transaction,
  ): Promise<{ id: string; kind: string; reference: string }[]> {
    return this.sequelize.query<{
      id: string;
      kind: string;
      reference: string;
    }>(
      `INSERT INTO "ReconciliationIssue" ("runId","day","kind","reference","details","createdAt")
       SELECT s."runId", $2::date, s."kind", s."reference", s."details", $3
         FROM "ReconciliationStaging" s WHERE s."runId" = $1
       ON CONFLICT ("runId","kind","reference") DO NOTHING
       RETURNING "id","kind","reference"`,
      {
        type: QueryTypes.SELECT,
        bind: [run.id, run.day, now],
        transaction: tx,
      },
    );
  }

  async autoResolve(
    issueIds: string[],
    now: Date,
    tx: Transaction,
  ): Promise<string[]> {
    if (issueIds.length === 0) return [];
    const resolved = await this.sequelize.query<{ id: string }>(
      `UPDATE "ReconciliationIssue"
          SET "status" = 'RESOLVED', "resolution" = 'auto_matched', "resolvedBy" = 'system', "resolvedAt" = $2
        WHERE "id" = ANY($1::uuid[]) AND "status" = 'OPEN' RETURNING "id"`,
      { type: QueryTypes.SELECT, bind: [issueIds, now], transaction: tx },
    );
    if (resolved.length > 0)
      await this.sequelize.query(
        `INSERT INTO "ReconciliationIssueHistory" ("issueId","at","actor","from","to","resolution")
         SELECT i, $2, 'system', 'OPEN', 'RESOLVED', 'auto_matched' FROM unnest($1::uuid[]) AS t(i)`,
        { bind: [resolved.map((r) => r.id), now], transaction: tx },
      );
    return resolved.map((r) => r.id);
  }

  async finishRun(
    run: RunRecord,
    counts: {
      providerLines: number;
      ledgerJournals: number;
      matched: number;
      skipped: number;
    },
    now: Date,
    tx: Transaction,
  ): Promise<{ issues: number } | null> {
    const [row] = await this.sequelize.query<{ issues: number }>(
      `UPDATE "ReconciliationRun" r
          SET "status" = 'COMPLETED', "providerLines" = $3, "ledgerJournals" = $4, "matched" = $5, "skipped" = $6,
              "issues" = (SELECT count(*) FROM "ReconciliationIssue" i WHERE i."runId" = r."id"),
              "finishedAt" = $7, "leaseUntil" = NULL
        WHERE r."id" = $1 AND r."startedAt" = $2 AND r."status" = 'RUNNING'
        RETURNING "issues"`,
      {
        type: QueryTypes.SELECT,
        bind: [
          run.id,
          run.startedAt,
          counts.providerLines,
          counts.ledgerJournals,
          counts.matched,
          counts.skipped,
          now,
        ],
        transaction: tx,
      },
    );
    return row ? { issues: Number(row.issues) } : null;
  }

  async purgeScratch(runId: string, tx?: Transaction): Promise<void> {
    await this.sequelize.query(
      `DELETE FROM "ReconciliationStaging" WHERE "runId" = $1`,
      { bind: [runId], transaction: tx },
    );
    await this.sequelize.query(
      `DELETE FROM "ReconciliationSeen" WHERE "runId" = $1`,
      { bind: [runId], transaction: tx },
    );
  }

  async failRun(
    run: RunRecord,
    code: 'provider_unavailable' | 'interrupted' | 'internal',
    now: Date,
  ): Promise<void> {
    await this.sequelize.query(
      `UPDATE "ReconciliationRun"
          SET "status" = 'FAILED', "failureCode" = $3, "finishedAt" = $4, "leaseUntil" = NULL
        WHERE "id" = $1 AND "startedAt" = $2 AND "status" = 'RUNNING'`,
      { bind: [run.id, run.startedAt, code, now] },
    );
    await this.purgeScratch(run.id);
  }

  async completedDays(
    provider: string,
    fromDay: string,
    toDayExclusive: string,
  ): Promise<string[]> {
    const rows = await this.sequelize.query<{ day: string }>(
      `SELECT "day"::text AS "day" FROM "ReconciliationRun"
        WHERE "provider" = $1 AND "status" = 'COMPLETED' AND "day" >= $2 AND "day" < $3`,
      { type: QueryTypes.SELECT, bind: [provider, fromDay, toDayExclusive] },
    );
    return rows.map((r) => r.day);
  }

  async listRuns(input: {
    limit: number;
    after: TimeKey | null;
  }): Promise<{ item: ReconciliationRun; t: string }[]> {
    const rows = await this.sequelize.query<RunRow & { t: string }>(
      `SELECT ${RUN_COLUMNS}, ${PG_TIME('"startedAt"')} AS "t" FROM "ReconciliationRun"
        WHERE ($1::timestamptz IS NULL OR ("startedAt", "id") < ($1::timestamptz, $2::uuid))
        ORDER BY "startedAt" DESC, "id" DESC LIMIT $3`,
      {
        type: QueryTypes.SELECT,
        bind: [input.after?.t ?? null, input.after?.id ?? null, input.limit],
      },
    );
    return rows.map((r) => ({
      t: r.t,
      item: {
        id: r.id,
        provider: r.provider,
        day: r.day,
        status: r.status,
        providerLines: r.providerLines,
        ledgerJournals: r.ledgerJournals,
        matched: r.matched,
        issueCount: r.issues,
        skipped: r.skipped,
        failureCode: r.failureCode as ReconciliationRun['failureCode'],
        startedAt: new Date(r.startedAt).toISOString(),
        finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
      },
    }));
  }

  async listIssues(input: {
    status?: string;
    kind?: string;
    day?: string;
    limit: number;
    after: TimeKey | null;
  }): Promise<{ item: ReconciliationIssue; t: string }[]> {
    const rows = await this.sequelize.query<IssueRow & { t: string }>(
      `SELECT ${ISSUE_COLUMNS}, ${PG_TIME('"createdAt"')} AS "t" FROM "ReconciliationIssue"
        WHERE ($1::text IS NULL OR "status" = $1) AND ($2::text IS NULL OR "kind" = $2)
          AND ($3::date IS NULL OR "day" = $3::date)
          AND ($4::timestamptz IS NULL OR ("createdAt", "id") < ($4::timestamptz, $5::uuid))
        ORDER BY "createdAt" DESC, "id" DESC LIMIT $6`,
      {
        type: QueryTypes.SELECT,
        bind: [
          input.status ?? null,
          input.kind ?? null,
          input.day ?? null,
          input.after?.t ?? null,
          input.after?.id ?? null,
          input.limit,
        ],
      },
    );
    return rows.map((r) => ({ t: r.t, item: toIssue(r) }));
  }

  async findIssue(
    id: string,
    tx?: Transaction,
  ): Promise<{ status: 'OPEN' | 'RESOLVED'; day: string } | null> {
    const [row] = await this.sequelize.query<{
      status: 'OPEN' | 'RESOLVED';
      day: string;
    }>(
      `SELECT "status", "day"::text AS "day" FROM "ReconciliationIssue" WHERE "id" = $1`,
      { type: QueryTypes.SELECT, bind: [id], transaction: tx },
    );
    return row ?? null;
  }

  async resolveOpenIssue(
    input: {
      id: string;
      resolution: 'explained' | 'adjusted';
      note: string;
      actor: string;
      now: Date;
    },
    tx: Transaction,
  ): Promise<ReconciliationIssue | null> {
    const [row] = await this.sequelize.query<IssueRow>(
      `UPDATE "ReconciliationIssue"
          SET "status" = 'RESOLVED', "resolution" = $2, "note" = $3, "resolvedBy" = $4, "resolvedAt" = $5
        WHERE "id" = $1 AND "status" = 'OPEN'
        RETURNING ${ISSUE_COLUMNS}`,
      {
        type: QueryTypes.SELECT,
        bind: [input.id, input.resolution, input.note, input.actor, input.now],
        transaction: tx,
      },
    );
    return row ? toIssue(row) : null;
  }

  async linkAdjustment(
    issueId: string,
    journalId: string,
    tx: Transaction,
  ): Promise<void> {
    await this.sequelize.query(
      `UPDATE "ReconciliationIssue" SET "adjustmentJournalId" = $2 WHERE "id" = $1`,
      { bind: [issueId, journalId], transaction: tx },
    );
  }

  async addHistory(
    input: {
      issueId: string;
      at: Date;
      actor: string;
      resolution: string;
      note: string | null;
    },
    tx: Transaction,
  ): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO "ReconciliationIssueHistory" ("issueId","at","actor","from","to","resolution","note")
       VALUES ($1,$2,$3,'OPEN','RESOLVED',$4,$5)`,
      {
        bind: [
          input.issueId,
          input.at,
          input.actor,
          input.resolution,
          input.note,
        ],
        transaction: tx,
      },
    );
  }

  async openIssueStats(
    now: Date,
  ): Promise<{ byKind: Record<string, number>; oldestAgeSeconds: number }> {
    const counts = await this.sequelize.query<{ kind: string; n: string }>(
      `SELECT "kind", count(*)::text AS n FROM "ReconciliationIssue" WHERE "status" = 'OPEN' GROUP BY "kind"`,
      { type: QueryTypes.SELECT },
    );
    const [oldest] = await this.sequelize.query<{ at: Date | null }>(
      `SELECT min("createdAt") AS at FROM "ReconciliationIssue" WHERE "status" = 'OPEN'`,
      { type: QueryTypes.SELECT },
    );
    return {
      byKind: Object.fromEntries(counts.map((c) => [c.kind, Number(c.n)])),
      oldestAgeSeconds: oldest?.at
        ? Math.max(0, (now.getTime() - new Date(oldest.at).getTime()) / 1000)
        : 0,
    };
  }
}
