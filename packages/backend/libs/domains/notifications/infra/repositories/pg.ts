import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { getActiveTransaction } from '@app/infrastructure/context';

/**
 * Runs a statement with bound values (`$1`, `$2`, ...) in the caller's transaction when there is one. Used for
 * `SELECT` and for `INSERT/UPDATE/DELETE ... RETURNING`.
 */
export function rows<T extends object>(
  sequelize: Sequelize,
  sql: string,
  bind: unknown[] = [],
): Promise<T[]> {
  return sequelize.query<T>(sql, {
    bind: bind as never[],
    transaction: getActiveTransaction(),
    type: QueryTypes.SELECT,
  });
}
