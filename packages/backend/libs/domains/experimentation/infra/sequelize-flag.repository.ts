import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import type { FlagRulesetSnapshot } from '@marketplace-sandbox/contracts';
import { getActiveTransaction } from '@app/infrastructure/context';
import type { FlagDefinitionBody, StoredFlag } from '../domain/flag-types';
import type {
  AuditEntry,
  AuditRow,
  FlagChange,
  FlagListQuery,
  FlagRepository,
  HistoryCursorKey,
  NewFlag,
} from '../domain/ports';

const FLAG_COLUMNS = `"key","description","status","variants","defaultVariant","offVariant","rules","bucketBy","clientSide","owner","expiresAt","version","createdAt","updatedAt"`;
const AT_TEXT = `to_char("at" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

interface FlagRow {
  key: string;
  description: string;
  status: StoredFlag['status'];
  variants: FlagDefinitionBody['variants'];
  defaultVariant: string;
  offVariant: string;
  rules: FlagRuleRow[];
  bucketBy: FlagDefinitionBody['bucketBy'];
  clientSide: boolean;
  owner: string;
  expiresAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
type FlagRuleRow = Omit<FlagDefinitionBody['rules'][number], 'conditions'> & {
  conditions: (Omit<
    FlagDefinitionBody['rules'][number]['conditions'][number],
    'values'
  > & { values?: (string | number | boolean)[] })[];
};

/** Rules as stored may predate the explicit `values` list (`exists` conditions): fill it so every reader sees one shape. */
const normalRules = (rules: FlagRuleRow[]): FlagDefinitionBody['rules'] =>
  rules.map((rule) => ({
    ...rule,
    conditions: rule.conditions.map((c) => ({ ...c, values: c.values ?? [] })),
  }));

const toFlag = (row: FlagRow): StoredFlag => ({
  key: row.key,
  status: row.status,
  version: Number(row.version),
  definition: {
    description: row.description,
    owner: row.owner,
    variants: row.variants,
    defaultVariant: row.defaultVariant,
    offVariant: row.offVariant,
    rules: normalRules(row.rules),
    bucketBy: row.bucketBy,
    clientSide: row.clientSide,
    expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
  },
  createdAt: new Date(row.createdAt).toISOString(),
  updatedAt: new Date(row.updatedAt).toISOString(),
});

const tx = () => ({ transaction: getActiveTransaction() });

/**
 * Postgres adapter of `FlagRepository` (S38): parameterised SQL with fixed column lists, joins the transaction of
 * `TransactionRunner.run` when there is one. Audit rows are only ever appended and read; there is no code path that
 * updates or deletes them (FR-050).
 */
@Injectable()
export class SequelizeFlagRepository implements FlagRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async lockRuleset(): Promise<number> {
    await this.sequelize.query(
      `INSERT INTO "FlagRuleset" ("id","version")
       SELECT 1, GREATEST(COALESCE(MAX("version"), 1), 1) FROM "FeatureFlag"
       ON CONFLICT ("id") DO NOTHING`,
      { ...tx(), type: QueryTypes.INSERT },
    );
    const [row] = await this.sequelize.query<{ version: string }>(
      `SELECT "version" FROM "FlagRuleset" WHERE "id" = 1 FOR UPDATE`,
      { ...tx(), type: QueryTypes.SELECT },
    );
    return Number(row.version);
  }

  async bumpRuleset(): Promise<number> {
    const [row] = await this.sequelize.query<{ version: string }>(
      `UPDATE "FlagRuleset" SET "version" = "version" + 1 WHERE "id" = 1 RETURNING "version"`,
      { ...tx(), type: QueryTypes.SELECT },
    );
    return Number(row.version);
  }

  async findForUpdate(key: string): Promise<StoredFlag | null> {
    const [row] = await this.sequelize.query<FlagRow>(
      `SELECT ${FLAG_COLUMNS} FROM "FeatureFlag" WHERE "key" = $1 FOR UPDATE`,
      { ...tx(), bind: [key], type: QueryTypes.SELECT },
    );
    return row ? toFlag(row) : null;
  }

  async find(key: string): Promise<StoredFlag | null> {
    const [row] = await this.sequelize.query<FlagRow>(
      `SELECT ${FLAG_COLUMNS} FROM "FeatureFlag" WHERE "key" = $1`,
      { ...tx(), bind: [key], type: QueryTypes.SELECT },
    );
    return row ? toFlag(row) : null;
  }

  async countLive(): Promise<number> {
    const [row] = await this.sequelize.query<{ n: string }>(
      `SELECT count(*) AS n FROM "FeatureFlag" WHERE "status" <> 'archived'`,
      { ...tx(), type: QueryTypes.SELECT },
    );
    return Number(row.n);
  }

  async insert(flag: NewFlag): Promise<StoredFlag> {
    const d = flag.definition;
    const [row] = await this.sequelize.query<FlagRow>(
      `INSERT INTO "FeatureFlag"
         ("key","description","status","enabled","variants","defaultVariant","offVariant","rules","bucketBy","clientSide","owner","expiresAt","version","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10,$11,$12,1,$13,$13)
       RETURNING ${FLAG_COLUMNS}`,
      {
        ...tx(),
        bind: [
          flag.key,
          d.description,
          flag.status,
          flag.status === 'enabled',
          JSON.stringify(d.variants),
          d.defaultVariant,
          d.offVariant,
          JSON.stringify(d.rules),
          d.bucketBy,
          d.clientSide,
          d.owner,
          d.expiresAt,
          flag.now,
        ],
        type: QueryTypes.SELECT,
      },
    );
    return toFlag(row);
  }

  async update(change: FlagChange): Promise<StoredFlag> {
    const d = change.definition;
    const rows = await this.sequelize.query<FlagRow>(
      `UPDATE "FeatureFlag" SET "description"=$3,"status"=$4,"enabled"=$5,"variants"=$6::jsonb,"defaultVariant"=$7,"offVariant"=$8,
         "rules"=$9::jsonb,"bucketBy"=$10,"clientSide"=$11,"owner"=$12,"expiresAt"=$13,"version"="version"+1,"updatedAt"=$14
       WHERE "key"=$1 AND "version"=$2
       RETURNING ${FLAG_COLUMNS}`,
      {
        ...tx(),
        bind: [
          change.key,
          change.expectedVersion,
          d.description,
          change.status,
          change.status === 'enabled',
          JSON.stringify(d.variants),
          d.defaultVariant,
          d.offVariant,
          JSON.stringify(d.rules),
          d.bucketBy,
          d.clientSide,
          d.owner,
          d.expiresAt,
          change.now,
        ],
        type: QueryTypes.SELECT,
      },
    );
    if (rows.length !== 1)
      throw new Error(
        `flag ${change.key} changed under its row lock (expected exactly one row at version ${change.expectedVersion})`,
      );
    return toFlag(rows[0]);
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO "FlagAudit" ("flagKey","actorId","action","before","after","requestId","at")
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)`,
      {
        ...tx(),
        bind: [
          entry.flagKey,
          entry.actorId,
          entry.action,
          entry.before === null ? null : JSON.stringify(entry.before),
          JSON.stringify(entry.after),
          entry.requestId,
          entry.at,
        ],
        type: QueryTypes.INSERT,
      },
    );
  }

  async list(query: FlagListQuery): Promise<StoredFlag[]> {
    const rows = await this.sequelize.query<FlagRow>(
      `SELECT ${FLAG_COLUMNS} FROM "FeatureFlag"
       WHERE ($1::text IS NULL OR "key" > $1)
         AND (CASE WHEN $2::text IS NOT NULL THEN "status" = $2
                   WHEN $3::boolean THEN TRUE ELSE "status" <> 'archived' END)
       ORDER BY "key" LIMIT $4`,
      {
        ...tx(),
        bind: [
          query.afterKey ?? null,
          query.status ?? null,
          query.includeArchived,
          query.limit,
        ],
        type: QueryTypes.SELECT,
      },
    );
    return rows.map(toFlag);
  }

  async history(
    key: string,
    limit: number,
    after?: HistoryCursorKey,
  ): Promise<AuditRow[]> {
    const rows = await this.sequelize.query<{
      id: string;
      flagKey: string;
      action: AuditRow['action'];
      actorId: string;
      requestId: string | null;
      at: string;
      before: AuditRow['before'];
      after: AuditRow['after'];
    }>(
      `SELECT "id","flagKey","action","actorId","requestId",${AT_TEXT} AS "at","before","after" FROM "FlagAudit"
       WHERE "flagKey" = $1 AND ($2::timestamptz IS NULL OR ("at","id") < ($2::timestamptz, $3::bigint))
       ORDER BY "at" DESC, "id" DESC LIMIT $4`,
      {
        ...tx(),
        bind: [key, after?.at ?? null, after?.id ?? null, limit],
        type: QueryTypes.SELECT,
      },
    );
    return rows.map((r) => ({ ...r, id: String(r.id) }));
  }

  async hasHistory(key: string): Promise<boolean> {
    const rows = await this.sequelize.query(
      `SELECT 1 FROM "FlagAudit" WHERE "flagKey" = $1 LIMIT 1`,
      { ...tx(), bind: [key], type: QueryTypes.SELECT },
    );
    return rows.length > 0;
  }

  async staleCandidates(): Promise<StoredFlag[]> {
    const rows = await this.sequelize.query<FlagRow>(
      `SELECT ${FLAG_COLUMNS} FROM "FeatureFlag" WHERE "status" <> 'archived' ORDER BY "key"`,
      { ...tx(), type: QueryTypes.SELECT },
    );
    return rows.map(toFlag);
  }

  async loadSnapshot(): Promise<FlagRulesetSnapshot> {
    const rows = await this.sequelize.query<
      FlagRow & { rulesetVersion: string | null }
    >(
      `SELECT COALESCE(r."version", 0) AS "rulesetVersion", f."key", f."status", f."variants", f."defaultVariant", f."offVariant",
              f."rules", f."bucketBy", f."clientSide", f."version"
       FROM (SELECT 1) one
       LEFT JOIN "FlagRuleset" r ON r."id" = 1
       LEFT JOIN "FeatureFlag" f ON f."status" <> 'archived'
       ORDER BY f."key"`,
      { ...tx(), type: QueryTypes.SELECT },
    );
    const version = Number(rows[0]?.rulesetVersion ?? 0);
    return {
      version,
      flags: rows
        .filter((r) => r.key !== null)
        .map((r) => ({
          key: r.key,
          status: r.status as 'enabled' | 'disabled' | 'killed',
          variants: r.variants,
          defaultVariant: r.defaultVariant,
          offVariant: r.offVariant,
          rules: normalRules(
            r.rules,
          ) as FlagRulesetSnapshot['flags'][number]['rules'],
          bucketBy: r.bucketBy,
          clientSide: r.clientSide,
          version: Number(r.version),
        })),
    };
  }

  async rulesetVersion(): Promise<number> {
    const [row] = await this.sequelize.query<{ version: string }>(
      `SELECT COALESCE((SELECT "version" FROM "FlagRuleset" WHERE "id" = 1), 0) AS "version"`,
      { ...tx(), type: QueryTypes.SELECT },
    );
    return Number(row.version);
  }
}
