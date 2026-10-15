import type {
  ListPage,
  PageQuery,
  ReconciliationFinding,
  ReconciliationOutcome,
  ReconciliationRecord,
} from './records';

export const RECONCILIATION_REPOSITORY = Symbol('RECONCILIATION_REPOSITORY');

export const MAX_FINDINGS = 1000;

export interface ReconciliationRepository {
  start(
    integrationId: string,
    startedAt: Date,
    previousRunId: string | null,
  ): Promise<string>;
  /** Stores at most 1,000 findings (`truncated` is set when more were given). `false` when already finished. */
  finish(
    id: string,
    result: {
      outcome: ReconciliationOutcome;
      counts: Record<string, number>;
      findings: ReconciliationFinding[];
    },
    finishedAt: Date,
  ): Promise<boolean>;
  /** Latest finished run (for `previousRunId` and the lag view). */
  findLatestFinished(
    integrationId: string,
  ): Promise<ReconciliationRecord | null>;
  findInIntegration(
    integrationId: string,
    id: string,
  ): Promise<ReconciliationRecord | null>;
  /** `(startedAt DESC, id DESC)`; summaries carry empty `findings`. */
  listPage(
    integrationId: string,
    query: PageQuery,
  ): Promise<ListPage<ReconciliationRecord>>;
  /** Retention (90 days). DELETE stays allowed on finished rows. */
  purgeStartedBefore(before: Date, limit: number): Promise<number>;
  deleteByIntegration(integrationId: string): Promise<number>;
}
