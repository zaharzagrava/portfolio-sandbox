/**
 * SQL fragments shared by the repositories of this domain. Everything here is a constant: values reach the database
 * only as bound parameters (constitution III.1).
 */
export const ISO_FORMAT = `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`;

/** A finite `timestamptz` as `2026-04-01T09:00:00.123456Z`; infinite and unbounded values become NULL. */
export const iso = (expression: string): string =>
  `CASE WHEN isfinite(${expression}) THEN to_char((${expression}) AT TIME ZONE 'UTC', '${ISO_FORMAT}') END`;

export { trimMicros } from '../domain/recorded-instant';

/** Month as `YYYY-MM` from a `DATE` column. */
export const monthText = (expression: string): string =>
  `to_char(${expression}, 'YYYY-MM')`;
