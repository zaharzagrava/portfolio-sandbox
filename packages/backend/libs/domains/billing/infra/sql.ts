import { QueryTypes, type Sequelize } from 'sequelize';
import { parseMinor } from '../domain/money';

/**
 * Helpers shared by the repositories of this domain. SQL lives only in `infra/` (I.2); values reach the database only
 * as bound parameters (III.1); the transaction is the caller's (CLS), never opened here.
 */
export const select = <T extends object>(
  sequelize: Sequelize,
  sql: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> =>
  sequelize.query<T>(sql, { type: QueryTypes.SELECT, replacements });

export const run = async (
  sequelize: Sequelize,
  sql: string,
  replacements: Record<string, unknown> = {},
): Promise<void> => {
  await sequelize.query(sql, { replacements });
};

export const minor = (value: string | number | bigint | null): number =>
  parseMinor(value);

export const minorOrNull = (
  value: string | number | bigint | null | undefined,
) => (value === null || value === undefined ? null : parseMinor(value));

export const dateOrNull = (
  value: Date | string | null | undefined,
): Date | null =>
  value === null || value === undefined ? null : new Date(value);

/** `2026-04-10T12:00:00.123456Z` from a `timestamptz` expression: the keyset position keeps microseconds. */
export const isoMicros = (expression: string): string =>
  `to_char((${expression}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
