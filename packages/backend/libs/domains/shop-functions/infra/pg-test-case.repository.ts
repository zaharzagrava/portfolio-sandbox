import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import type { TestCase } from '../domain/contract';
import type { TestCaseRepository } from '../domain/ports';

/** The current (`version IS NULL`) suite of a function; the frozen copies are written by the version repository. */
@Injectable()
export class PgTestCaseRepository implements TestCaseRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async replaceCurrent(
    shopId: string,
    functionId: string,
    tests: TestCase[],
  ): Promise<boolean> {
    const owned = await this.sequelize.query<{ id: string }>(
      `SELECT "id" FROM "ShopFunction" WHERE "id" = :functionId AND "shopId" = :shopId FOR UPDATE`,
      { type: QueryTypes.SELECT, replacements: { shopId, functionId } },
    );
    if (owned.length === 0) return false;
    await this.sequelize.query(
      `DELETE FROM "ShopFunctionTestCase" WHERE "functionId" = :functionId AND "version" IS NULL`,
      { replacements: { functionId } },
    );
    if (tests.length > 0)
      await this.sequelize.query(
        `INSERT INTO "ShopFunctionTestCase" ("functionId", "version", "name", "input", "expected")
         SELECT :functionId, NULL, c."value" ->> 'name', c."value" -> 'input', c."value" -> 'expected'
         FROM jsonb_array_elements(CAST(:cases AS jsonb)) WITH ORDINALITY AS c("value", "ord")
         ORDER BY c."ord"`,
        { replacements: { functionId, cases: JSON.stringify(tests) } },
      );
    return true;
  }

  async current(shopId: string, functionId: string) {
    const owned = await this.sequelize.query<{ id: string }>(
      `SELECT "id" FROM "ShopFunction" WHERE "id" = :functionId AND "shopId" = :shopId`,
      { type: QueryTypes.SELECT, replacements: { shopId, functionId } },
    );
    if (owned.length === 0) return null;
    return this.sequelize.query<TestCase>(
      `SELECT "name", "input", "expected" FROM "ShopFunctionTestCase"
       WHERE "functionId" = :functionId AND "version" IS NULL ORDER BY "id"`,
      { type: QueryTypes.SELECT, replacements: { functionId } },
    );
  }
}
