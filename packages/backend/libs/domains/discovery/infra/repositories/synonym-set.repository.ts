import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
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

interface SetRow {
  version: number;
  rules: string[];
  updatedAt: Date;
  updatedBy: string | null;
}

/** `SearchSynonymSet`: the single committed row (`id = 1`). Edits (claim and commit) arrive with the synonym admin routes. */
@Injectable()
export class SequelizeSynonymSetRepository implements SynonymSetRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async current(): Promise<SynonymSetSnapshot> {
    await this.sequelize.query(
      `INSERT INTO "SearchSynonymSet" ("id", "version", "rules", "updatedAt")
       VALUES (1, 1, $1::text[], now()) ON CONFLICT ("id") DO NOTHING`,
      { bind: [DEFAULT_SYNONYM_RULES] },
    );
    const [row] = await this.sequelize.query<SetRow>(
      `SELECT "version", "rules", "updatedAt", "updatedBy" FROM "SearchSynonymSet" WHERE "id" = 1`,
      { type: QueryTypes.SELECT },
    );
    return row;
  }
}
