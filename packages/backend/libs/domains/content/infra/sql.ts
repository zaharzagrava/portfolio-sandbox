import { QueryTypes, type Sequelize } from 'sequelize';

type Params = Record<string, unknown>;

/**
 * Raw SQL helpers of the repositories. Values are always bound (`$name`), arrays included, never interpolated. No
 * `transaction` option is passed: the CLS namespace joins a query to the transaction of the surrounding
 * `TransactionRunner.run` / `@Transactional` scope on its own.
 */
export function rows<T>(
  db: Sequelize,
  sql: string,
  bind: Params = {},
): Promise<T[]> {
  return db.query(sql, { type: QueryTypes.SELECT, bind }) as Promise<T[]>;
}

export async function one<T>(
  db: Sequelize,
  sql: string,
  bind: Params = {},
): Promise<T | null> {
  return (await rows<T>(db, sql, bind))[0] ?? null;
}

/** Statements that end in `RETURNING 1` (or any column): the number of rows written. */
export async function count(
  db: Sequelize,
  sql: string,
  bind: Params = {},
): Promise<number> {
  return (await rows<unknown>(db, sql, bind)).length;
}

/** Statements without a result set. */
export async function exec(
  db: Sequelize,
  sql: string,
  bind: Params = {},
): Promise<void> {
  await db.query(sql, { bind });
}

/** BIGINT and SUM results arrive as strings from the driver. */
export const num = (value: unknown): number => Number(value ?? 0);
