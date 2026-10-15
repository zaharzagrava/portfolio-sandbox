import { QueryTypes, type Sequelize } from 'sequelize';

type Replacements = Record<string, unknown>;

/**
 * Raw SQL helpers of the repositories. No `transaction` option is passed: the CLS namespace joins a query to the
 * transaction of the surrounding `TransactionRunner.run` / `@Transactional` scope on its own.
 */
export function rows<T>(
  db: Sequelize,
  sql: string,
  replacements: Replacements = {},
): Promise<T[]> {
  return db.query(sql, { type: QueryTypes.SELECT, replacements }) as Promise<
    T[]
  >;
}

export async function one<T>(
  db: Sequelize,
  sql: string,
  replacements: Replacements = {},
): Promise<T | null> {
  const found = await rows<T>(db, sql, replacements);
  return found[0] ?? null;
}

/** Statements that end in `RETURNING 1` (or any single column): the number of rows written. */
export async function count(
  db: Sequelize,
  sql: string,
  replacements: Replacements = {},
): Promise<number> {
  return (await rows<unknown>(db, sql, replacements)).length;
}

export const toDate = (v: unknown): Date | null =>
  v === null || v === undefined
    ? null
    : v instanceof Date
      ? v
      : new Date(v as string);

export const toDateRequired = (v: unknown): Date => toDate(v) as Date;

export const toNumber = (v: unknown): number => Number(v);

export const toNumberOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

export const json = (v: unknown): string => JSON.stringify(v ?? null);
