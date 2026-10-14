import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';

/** BIGINT arrives as a string; a value outside the safe range is a data error, never rounded (III.8). */
export function safeNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`value ${String(value)} is outside the safe integer range`);
  }
  return n;
}

/** A read; statements join the active transaction through CLS. */
export function select<T extends object>(
  sequelize: Sequelize,
  sql: string,
  replacements: object = {},
): Promise<T[]> {
  return sequelize.query<T>(sql, {
    type: QueryTypes.SELECT,
    replacements: replacements as Record<string, unknown>,
  });
}

export const pgCode = (error: unknown): string | undefined => {
  const e = error as {
    parent?: { code?: string };
    original?: { code?: string };
  };
  return e?.parent?.code ?? e?.original?.code;
};
