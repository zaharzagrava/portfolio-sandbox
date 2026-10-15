import type {
  SyncCounters,
  SyncRunKind,
  SyncRunOutcome,
  SyncRunRecord,
} from './records';

export const RUN_REPOSITORY = Symbol('RUN_REPOSITORY');

export interface RunRepository {
  start(
    integrationId: string,
    kind: SyncRunKind,
    startedAt: Date,
  ): Promise<string>;
  /** Only an unfinished run can finish; `false` otherwise. */
  finish(
    id: string,
    result: {
      outcome: SyncRunOutcome;
      counters: Partial<SyncCounters>;
      detail?: string | null;
    },
    finishedAt: Date,
  ): Promise<boolean>;
  listRecent(integrationId: string, limit: number): Promise<SyncRunRecord[]>;
  /** Retention (30 days). Returns the deleted count. */
  purgeStartedBefore(before: Date, limit: number): Promise<number>;
}
