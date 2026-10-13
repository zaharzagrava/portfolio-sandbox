import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { TransactionRunner } from '@app/infrastructure/context';
import type {
  SynonymSetRepository,
  SynonymSetSnapshot,
} from '../../domain/ports';

/** The rules the code carried before they were stored; used only when the seeded row is missing. */
export const DEFAULT_SYNONYM_RULES = [
  'airpods, earbuds, wireless headphones',
  'phone, smartphone, mobile',
  'laptop, notebook',
  'tv, television',
  'sneakers, trainers',
];

/** The history keeps the newest versions only, and nothing older than this. */
export const SYNONYM_HISTORY_VERSIONS = 20;
export const SYNONYM_HISTORY_DAYS = 90;

interface SetRow {
  version: number;
  rules: string[];
  updatedAt: Date;
  updatedBy: string | null;
}

const SET_COLUMNS = `"version", "rules", "updatedAt", "updatedBy"`;

/**
 * `SearchSynonymSet`: the single committed row (`id = 1`) with the claim columns of an edit in flight, and
 * `SearchSynonymVersion`, the history. A claim is `UPDATE … WHERE version = :expected AND no fresh claim`, so exactly one
 * of two concurrent edits proceeds to the engine (III.6); the engine call happens outside any transaction (III.3).
 */
@Injectable()
export class SequelizeSynonymSetRepository implements SynonymSetRepository {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly transactions: TransactionRunner,
  ) {}

  async current(): Promise<SynonymSetSnapshot> {
    await this.sequelize.query(
      `INSERT INTO "SearchSynonymSet" ("id", "version", "rules", "updatedAt")
       VALUES (1, 1, $1::text[], now()) ON CONFLICT ("id") DO NOTHING`,
      { bind: [DEFAULT_SYNONYM_RULES] },
    );
    const [row] = await this.sequelize.query<SetRow>(
      `SELECT ${SET_COLUMNS} FROM "SearchSynonymSet" WHERE "id" = 1`,
      { type: QueryTypes.SELECT },
    );
    return row;
  }

  async claim(
    expectedVersion: number,
    rules: string[],
    now: Date,
    staleBefore: Date,
  ): Promise<boolean> {
    const rows = await this.sequelize.query(
      `UPDATE "SearchSynonymSet"
          SET "pendingVersion" = "version" + 1, "pendingRules" = $2::text[], "pendingAt" = $3
        WHERE "id" = 1 AND "version" = $1
          AND ("pendingVersion" IS NULL OR "pendingAt" < $4)
        RETURNING "version"`,
      {
        type: QueryTypes.SELECT,
        bind: [expectedVersion, rules, now, staleBefore],
      },
    );
    return rows.length === 1;
  }

  async claimInFlight(staleBefore: Date): Promise<boolean> {
    const rows = await this.sequelize.query(
      `SELECT 1 FROM "SearchSynonymSet"
        WHERE "id" = 1 AND "pendingVersion" IS NOT NULL AND "pendingAt" >= $1`,
      { type: QueryTypes.SELECT, bind: [staleBefore] },
    );
    return rows.length === 1;
  }

  async commit(
    version: number,
    actorId: string,
    now: Date,
  ): Promise<SynonymSetSnapshot> {
    return this.transactions.run(async (tx) => {
      // the version being replaced stays retrievable
      await this.sequelize.query(
        `INSERT INTO "SearchSynonymVersion" ("version", "rules", "updatedBy", "createdAt")
         SELECT "version", "rules", "updatedBy", "updatedAt" FROM "SearchSynonymSet" WHERE "id" = 1
         ON CONFLICT ("version") DO NOTHING`,
        { transaction: tx },
      );
      const [row] = await this.sequelize.query<SetRow>(
        `UPDATE "SearchSynonymSet"
            SET "version" = "pendingVersion", "rules" = "pendingRules", "updatedBy" = $2, "updatedAt" = $3,
                "pendingVersion" = NULL, "pendingRules" = NULL, "pendingAt" = NULL
          WHERE "id" = 1 AND "pendingVersion" = $1
          RETURNING ${SET_COLUMNS}`,
        {
          type: QueryTypes.SELECT,
          bind: [version, actorId, now],
          transaction: tx,
        },
      );
      if (!row) throw new Error(`synonym claim ${version} was lost`);
      await this.sequelize.query(
        `INSERT INTO "SearchSynonymVersion" ("version", "rules", "updatedBy", "createdAt")
         VALUES ($1, $2::text[], $3, $4) ON CONFLICT ("version") DO NOTHING`,
        {
          bind: [row.version, row.rules, actorId, now],
          transaction: tx,
        },
      );
      await this.sequelize.query(
        `DELETE FROM "SearchSynonymVersion"
          WHERE "version" <> $1
            AND ("version" <= $1 - $2 OR "createdAt" < $3::timestamptz - make_interval(days => $4))`,
        {
          bind: [
            row.version,
            SYNONYM_HISTORY_VERSIONS,
            now,
            SYNONYM_HISTORY_DAYS,
          ],
          transaction: tx,
        },
      );
      return row;
    });
  }

  async release(version: number): Promise<void> {
    await this.sequelize.query(
      `UPDATE "SearchSynonymSet"
          SET "pendingVersion" = NULL, "pendingRules" = NULL, "pendingAt" = NULL
        WHERE "id" = 1 AND "pendingVersion" = $1`,
      { bind: [version] },
    );
  }
}
