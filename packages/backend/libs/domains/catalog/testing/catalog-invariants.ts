import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';

/**
 * The impossible states a race on products could leave behind. Every query must find nothing; `impossibleRows` returns
 * what it found (an empty list is good), so a failing spec prints the offending rows. Test code only: it reads
 * the tables directly (constitution IX.6). The event and history checks assume every product was made through the API
 * (the seed helpers write a row without its event and history, which these checks would call a lost write).
 */
export async function impossibleProductRows(
  app: INestApplication,
): Promise<Record<string, unknown[]>> {
  const sequelize = app.get(Sequelize);
  const find = (sql: string) =>
    sequelize.query<Record<string, unknown>>(sql, { type: QueryTypes.SELECT });
  return {
    negativeOrHugeStock: await find(
      `SELECT "id", "quantity" FROM "Product" WHERE "quantity" < 0 OR "quantity" > 1000000000`,
    ),
    versionBelowOne: await find(
      `SELECT "id", "version" FROM "Product" WHERE "version" < 1`,
    ),
    // two outbox events of one product that claim the same version = two winners of one expectedVersion
    twoEventsOneVersion: await find(
      `SELECT "aggregateId", "payload"->>'aggregateVersion' AS "version", count(*)::int AS "n"
         FROM "Outbox" WHERE "type" LIKE 'catalog.product_%'
        GROUP BY 1, 2 HAVING count(*) > 1`,
    ),
    // a product row at version v has exactly v events (create + one per change); more or fewer = a lost or doubled write
    eventsDoNotMatchVersion: await find(
      `SELECT p."id", p."version", count(o."id")::int AS "events"
         FROM "Product" p LEFT JOIN "Outbox" o
           ON o."aggregateId" = p."id"::text AND o."type" LIKE 'catalog.product_%'
        GROUP BY p."id", p."version"
       HAVING count(o."id") <> p."version"`,
    ),
    // events, status history and stock operations that point at a product that does not exist
    orphanEvents: await find(
      `SELECT o."aggregateId" FROM "Outbox" o
        WHERE o."type" LIKE 'catalog.product_%'
          AND NOT EXISTS (SELECT 1 FROM "Product" p WHERE p."id"::text = o."aggregateId")`,
    ),
    orphanHistory: await find(
      `SELECT h."productId" FROM "ProductStatusHistory" h
        WHERE NOT EXISTS (SELECT 1 FROM "Product" p WHERE p."id" = h."productId")`,
    ),
    orphanStockOperations: await find(
      `SELECT s."operationId" FROM "ProductStockOperation" s
        WHERE NOT EXISTS (SELECT 1 FROM "Product" p WHERE p."id" = s."productId")`,
    ),
    // the same product moved to the same status twice in a row
    historyNotAlternating: await find(
      `SELECT "productId", "productVersion" FROM "ProductStatusHistory"
        GROUP BY 1, 2 HAVING count(*) > 1`,
    ),
    // an archived product must have a last history row that says ARCHIVED, an active one must not end on ARCHIVED
    statusWithoutHistory: await find(
      `SELECT p."id", p."status" FROM "Product" p
        WHERE p."status" = 'ARCHIVED'
          AND COALESCE((SELECT h."toStatus" FROM "ProductStatusHistory" h
                         WHERE h."productId" = p."id" ORDER BY h."productVersion" DESC, h."at" DESC LIMIT 1), 'NONE') <> 'ARCHIVED'`,
    ),
  };
}

/** What `impossibleProductRows` returns when nothing is wrong: `expect(await impossibleProductRows(app)).toEqual(NOTHING_IMPOSSIBLE)`. */
export const NOTHING_IMPOSSIBLE = {
  negativeOrHugeStock: [],
  versionBelowOne: [],
  twoEventsOneVersion: [],
  eventsDoNotMatchVersion: [],
  orphanEvents: [],
  orphanHistory: [],
  orphanStockOperations: [],
  historyNotAlternating: [],
  statusWithoutHistory: [],
};
