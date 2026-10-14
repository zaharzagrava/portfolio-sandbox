import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { getActiveTransaction } from '@app/infrastructure/context';
import type {
  ExperimentAction,
  ExperimentStatus,
  ListedExperiment,
  RunningExperiment,
  StoredExperiment,
} from '../domain/experiment-types';
import {
  LayerOverlapError,
  type ExperimentAuditEntry,
  type ExperimentAuditRow,
  type ExperimentChange,
  type ExperimentListQuery,
  type ExperimentRepository,
  type ExperimentTransition,
  type HistoryCursorKey,
  type NewExperiment,
} from '../domain/ports';

const COLUMNS = `"key","description","owner","unit","status","variants","layer","layerFrom","layerTo","metric","version","startedAt","stoppedAt","startedBy","stoppedBy","createdAt","updatedAt"`;
const CREATED_KEY = `to_char("createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAtKey"`;
const AT_TEXT = `to_char("at" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

interface ExperimentRow {
  key: string;
  description: string;
  owner: string;
  unit: StoredExperiment['unit'];
  status: 'DRAFT' | 'RUNNING' | 'STOPPED';
  variants: StoredExperiment['variants'];
  layer: string;
  layerFrom: number;
  layerTo: number;
  metric: string;
  version: number;
  startedAt: Date | null;
  stoppedAt: Date | null;
  startedBy: string | null;
  stoppedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdAtKey?: string;
}

const toExperiment = (row: ExperimentRow): ListedExperiment => ({
  key: row.key,
  description: row.description,
  owner: row.owner,
  unit: row.unit,
  status: row.status.toLowerCase() as ExperimentStatus,
  variants: row.variants,
  layer: row.layer,
  layerFrom: Number(row.layerFrom),
  layerTo: Number(row.layerTo),
  metric: row.metric,
  version: Number(row.version),
  startedAt: row.startedAt ? new Date(row.startedAt) : null,
  stoppedAt: row.stoppedAt ? new Date(row.stoppedAt) : null,
  startedBy: row.startedBy,
  stoppedBy: row.stoppedBy,
  createdAt: new Date(row.createdAt),
  updatedAt: new Date(row.updatedAt),
  createdAtKey: row.createdAtKey ?? new Date(row.createdAt).toISOString(),
});

const tx = () => ({ transaction: getActiveTransaction() });

const EXCLUSION_VIOLATION = '23P01';
const isExclusionViolation = (error: unknown): boolean => {
  const e = error as {
    name?: string;
    parent?: { code?: string };
    original?: { code?: string };
  };
  return (
    e?.name === 'SequelizeExclusionConstraintError' ||
    e?.parent?.code === EXCLUSION_VIOLATION ||
    e?.original?.code === EXCLUSION_VIOLATION
  );
};

/**
 * Postgres adapter of `ExperimentRepository` (S39): parameterised SQL with fixed column lists, joins the transaction of
 * `TransactionRunner.run` when there is one. Audit rows are only appended and read; there is no code path that updates or
 * deletes them (FR-026).
 */
@Injectable()
export class SequelizeExperimentRepository implements ExperimentRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async lockCreates(): Promise<void> {
    await this.sequelize.query(
      `SELECT pg_advisory_xact_lock(hashtext('experiments:create'))`,
      { ...tx(), type: QueryTypes.SELECT },
    );
  }

  async findForUpdate(key: string): Promise<StoredExperiment | null> {
    const [row] = await this.sequelize.query<ExperimentRow>(
      `SELECT ${COLUMNS} FROM "Experiment" WHERE "key" = $1 FOR UPDATE`,
      { ...tx(), bind: [key], type: QueryTypes.SELECT },
    );
    return row ? toExperiment(row) : null;
  }

  async find(key: string): Promise<StoredExperiment | null> {
    const [row] = await this.sequelize.query<ExperimentRow>(
      `SELECT ${COLUMNS} FROM "Experiment" WHERE "key" = $1`,
      { ...tx(), bind: [key], type: QueryTypes.SELECT },
    );
    return row ? toExperiment(row) : null;
  }

  async count(): Promise<number> {
    const [row] = await this.sequelize.query<{ n: string }>(
      `SELECT count(*) AS n FROM "Experiment"`,
      { ...tx(), type: QueryTypes.SELECT },
    );
    return Number(row.n);
  }

  async insert(experiment: NewExperiment): Promise<StoredExperiment> {
    const d = experiment.definition;
    const [row] = await this.sequelize.query<ExperimentRow>(
      `INSERT INTO "Experiment"
         ("key","description","owner","unit","status","variants","layer","layerFrom","layerTo","metric","version","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,'DRAFT',$5::jsonb,$6,$7,$8,$9,1,$10,$10)
       RETURNING ${COLUMNS}`,
      {
        ...tx(),
        bind: [
          experiment.key,
          d.description,
          d.owner,
          d.unit,
          JSON.stringify(d.variants),
          d.layer,
          d.layerFrom,
          d.layerTo,
          d.metric,
          experiment.now,
        ],
        type: QueryTypes.SELECT,
      },
    );
    return toExperiment(row);
  }

  async update(change: ExperimentChange): Promise<StoredExperiment> {
    const d = change.definition;
    const rows = await this.sequelize.query<ExperimentRow>(
      `UPDATE "Experiment" SET "description" = $3, "owner" = $4, "unit" = $5, "variants" = $6::jsonb, "layer" = $7,
         "layerFrom" = $8, "layerTo" = $9, "metric" = $10, "version" = "version" + 1, "updatedAt" = $11
       WHERE "key" = $1 AND "version" = $2
       RETURNING ${COLUMNS}`,
      {
        ...tx(),
        bind: [
          change.key,
          change.expectedVersion,
          d.description,
          d.owner,
          d.unit,
          JSON.stringify(d.variants),
          d.layer,
          d.layerFrom,
          d.layerTo,
          d.metric,
          change.now,
        ],
        type: QueryTypes.SELECT,
      },
    );
    return this.exactlyOne(rows, `update of ${change.key}`);
  }

  async transition(change: ExperimentTransition): Promise<StoredExperiment> {
    const running = change.to === 'running';
    try {
      const rows = await this.sequelize.query<ExperimentRow>(
        `UPDATE "Experiment" SET "status" = $3,
           "startedAt" = CASE WHEN $4 THEN $5::timestamptz ELSE "startedAt" END,
           "startedBy" = CASE WHEN $4 THEN $6 ELSE "startedBy" END,
           "stoppedAt" = CASE WHEN $4 THEN "stoppedAt" ELSE $5::timestamptz END,
           "stoppedBy" = CASE WHEN $4 THEN "stoppedBy" ELSE $6 END,
           "version" = "version" + 1, "updatedAt" = $5::timestamptz
         WHERE "key" = $1 AND "status" = $2
         RETURNING ${COLUMNS}`,
        {
          ...tx(),
          bind: [
            change.key,
            change.from.toUpperCase(),
            change.to.toUpperCase(),
            running,
            change.now,
            change.actorId,
          ],
          type: QueryTypes.SELECT,
        },
      );
      return this.exactlyOne(rows, `${change.to} of ${change.key}`);
    } catch (error) {
      if (isExclusionViolation(error)) throw new LayerOverlapError();
      throw error;
    }
  }

  async appendAudit(entry: ExperimentAuditEntry): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO "ExperimentAudit" ("id","experimentKey","action","actorId","requestId","before","after","at")
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
      {
        ...tx(),
        bind: [
          entry.experimentKey,
          entry.action,
          entry.actorId,
          entry.requestId,
          entry.before === null ? null : JSON.stringify(entry.before),
          JSON.stringify(entry.after),
          entry.at,
        ],
        type: QueryTypes.INSERT,
      },
    );
  }

  async list(query: ExperimentListQuery): Promise<ListedExperiment[]> {
    const rows = await this.sequelize.query<ExperimentRow>(
      `SELECT ${COLUMNS}, ${CREATED_KEY} FROM "Experiment"
       WHERE ($1::text IS NULL OR "status" = $1)
         AND ($2::timestamptz IS NULL OR ("createdAt", "key") < ($2::timestamptz, $3::text))
       ORDER BY "createdAt" DESC, "key" DESC
       LIMIT $4`,
      {
        ...tx(),
        bind: [
          query.status ? query.status.toUpperCase() : null,
          query.after?.createdAt ?? null,
          query.after?.key ?? null,
          query.limit,
        ],
        type: QueryTypes.SELECT,
      },
    );
    return rows.map(toExperiment);
  }

  async history(
    key: string,
    limit: number,
    after?: HistoryCursorKey,
  ): Promise<ExperimentAuditRow[]> {
    const rows = await this.sequelize.query<{
      id: string;
      action: ExperimentAction;
      actorId: string;
      requestId: string | null;
      at: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown>;
    }>(
      `SELECT "id","action","actorId","requestId","before","after", ${AT_TEXT} AS "at"
       FROM "ExperimentAudit"
       WHERE "experimentKey" = $1
         AND ($2::timestamptz IS NULL OR ("at", "id") < ($2::timestamptz, $3::uuid))
       ORDER BY "at" DESC, "id" DESC
       LIMIT $4`,
      {
        ...tx(),
        bind: [key, after?.at ?? null, after?.id ?? null, limit],
        type: QueryTypes.SELECT,
      },
    );
    return rows;
  }

  async listRunning(): Promise<RunningExperiment[]> {
    const rows = await this.sequelize.query<ExperimentRow>(
      `SELECT "key","unit","variants","layer","layerFrom","layerTo" FROM "Experiment" WHERE "status" = 'RUNNING' ORDER BY "key"`,
      { ...tx(), type: QueryTypes.SELECT },
    );
    return rows.map((row) => ({
      key: row.key,
      unit: row.unit,
      variants: row.variants,
      layer: row.layer,
      layerFrom: Number(row.layerFrom),
      layerTo: Number(row.layerTo),
    }));
  }

  async findBlocking(
    layer: string,
    from: number,
    to: number,
  ): Promise<string | null> {
    const [row] = await this.sequelize.query<{ key: string }>(
      `SELECT "key" FROM "Experiment"
       WHERE "status" = 'RUNNING' AND "layer" = $1 AND int4range("layerFrom","layerTo") && int4range($2::int,$3::int)
       ORDER BY "key" LIMIT 1`,
      { ...tx(), bind: [layer, from, to], type: QueryTypes.SELECT },
    );
    return row?.key ?? null;
  }

  private exactlyOne(rows: ExperimentRow[], what: string): StoredExperiment {
    if (rows.length !== 1)
      throw new Error(
        `${what} changed ${rows.length} rows, expected exactly one`,
      );
    return toExperiment(rows[0]);
  }
}
