import type {
  SyncField,
  SyncOpResult,
  SyncResultCode,
} from '@marketplace-sandbox/contracts';
import type {
  ConflictInput,
  OutcomeRecord,
  SyncOperationRow,
} from '../domain/ports';

/** What executing one operation decided: a result to record, or a reason to answer `retry` and record nothing. */
export type Executed =
  | { kind: 'done'; outcome: OutcomeRecord; conflict?: ConflictInput }
  | { kind: 'retry'; code: 'in_flight' | 'contention' | 'deadline_exceeded' };

export const rejection = (
  code: SyncResultCode,
  detail?: Record<string, unknown>,
): Executed => ({
  kind: 'done',
  outcome: { status: 'rejected', code, ...(detail ? { detail } : {}) },
});

/** The response member of one stored outcome. `applied`, `superseded` and `conflict` live inside the stored detail. */
export function resultOf(
  index: number,
  opId: string | null,
  outcome: OutcomeRecord,
  replayed: boolean,
): SyncOpResult {
  const { applied, superseded, conflict, ...rest } = (outcome.detail ?? {}) as {
    applied?: SyncField[];
    superseded?: SyncField[];
    conflict?: SyncOpResult['conflict'];
  } & Record<string, unknown>;
  return {
    index,
    opId,
    status: outcome.status,
    replayed,
    ...(outcome.code ? { code: outcome.code } : {}),
    ...(Object.keys(rest).length > 0 ? { detail: rest } : {}),
    ...(outcome.quantityAfter !== undefined
      ? { quantityAfter: outcome.quantityAfter }
      : {}),
    ...(outcome.productVersion !== undefined
      ? { productVersion: outcome.productVersion }
      : {}),
    ...(applied ? { applied } : {}),
    ...(superseded ? { superseded } : {}),
    ...(conflict ? { conflict } : {}),
  };
}

export function outcomeOf(row: SyncOperationRow): OutcomeRecord {
  return {
    status: row.status as OutcomeRecord['status'],
    ...(row.code ? { code: row.code } : {}),
    ...(row.detail ? { detail: row.detail } : {}),
    ...(row.quantityAfter !== null ? { quantityAfter: row.quantityAfter } : {}),
    ...(row.productVersion !== null
      ? { productVersion: row.productVersion }
      : {}),
  };
}

export const retryResult = (
  index: number,
  opId: string | null,
  code: 'in_flight' | 'contention' | 'deadline_exceeded',
): SyncOpResult => ({
  index,
  opId,
  status: 'retry',
  replayed: false,
  code,
});
